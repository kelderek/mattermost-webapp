// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';
import {Route, Switch} from 'react-router-dom';
import iNoBounce from 'inobounce';

import {startPeriodicStatusUpdates, stopPeriodicStatusUpdates} from 'actions/status_actions';
import {reconnect} from 'actions/websocket_actions.jsx';
import * as GlobalActions from 'actions/global_actions';

import Constants from 'utils/constants';
import * as UserAgent from 'utils/user_agent';
import * as Utils from 'utils/utils';
import {isGuest} from 'mattermost-redux/utils/user_utils';

import {makeAsyncComponent} from 'components/async_load';
const LazyBackstageController = React.lazy(() => import('components/backstage'));
import ChannelController from 'components/channel_layout/channel_controller';
import Pluggable from 'plugins/pluggable';

import LocalStorageStore from 'stores/local_storage_store';
import type {isCollapsedThreadsEnabled} from 'mattermost-redux/selectors/entities/preferences';

import {UserProfile, UserStatus} from '@mattermost/types/users';
import {Group} from '@mattermost/types/groups';
import {Team, TeamMembership} from '@mattermost/types/teams';
import {Channel, ChannelMembership} from '@mattermost/types/channels';

const BackstageController = makeAsyncComponent('BackstageController', LazyBackstageController);

let wakeUpInterval: number;
let lastTime = Date.now();
const WAKEUP_CHECK_INTERVAL = 30000; // 30 seconds
const WAKEUP_THRESHOLD = 60000; // 60 seconds
const UNREAD_CHECK_TIME_MILLISECONDS = 10000;

declare global {
    interface Window {
        isActive: boolean;
    }
}

type Props = {
    license: Record<string, any>;
    currentUser?: UserProfile;
    currentChannelId?: string;
    currentTeamId?: string;
    actions: {
        fetchMyChannelsAndMembersREST: (teamId: string) => Promise<{ data: { channels: Channel[]; members: ChannelMembership[] } }>;
        fetchAllMyTeamsChannelsAndChannelMembersREST: () => Promise<{ data: { channels: Channel[]; members: ChannelMembership[]} }>;
        getMyTeamUnreads: (collapsedThreads: boolean) => Promise<{data: any; error?: any}>;
        viewChannel: (channelId: string, prevChannelId?: string | undefined) => Promise<{data: boolean}>;
        markChannelAsReadOnFocus: (channelId: string) => Promise<{data: any; error?: any}>;
        getTeamByName: (teamName: string) => Promise<{data: Team}>;
        addUserToTeam: (teamId: string, userId?: string) => Promise<{data: TeamMembership; error?: any}>;
        selectTeam: (team: Team) => Promise<{data: boolean}>;
        setPreviousTeamId: (teamId: string) => Promise<{data: boolean}>;
        loadStatusesForChannelAndSidebar: () => Promise<{data: UserStatus[]}>;
        getAllGroupsAssociatedToChannelsInTeam: (teamId: string, filterAllowReference: boolean) => Promise<{data: Group[]}>;
        getAllGroupsAssociatedToTeam: (teamId: string, filterAllowReference: boolean) => Promise<{data: Group[]}>;
        getGroupsByUserIdPaginated: (userId: string, filterAllowReference: boolean, page: number, perPage: number, includeMemberCount: boolean) => Promise<{data: Group[]}>;
        getGroups: (filterAllowReference: boolean, page: number, perPage: number) => Promise<{data: Group[]}>;
    };
    mfaRequired: boolean;
    match: {
        params: {
            team: string;
        };
    };
    previousTeamId?: string;
    history: {
        push(path: string): void;
    };
    teamsList: Team[];
    collapsedThreads: ReturnType<typeof isCollapsedThreadsEnabled>;
    plugins?: any;
    selectedThreadId: string | null;
    shouldShowAppBar: boolean;
    isCustomGroupsEnabled: boolean;
}

type State = {
    team: Team | null;
    finishedFetchingChannels: boolean;
    prevTeam: string;
    teamsList: Team[];
}

export default class NeedsTeam extends React.PureComponent<Props, State> {
    public blurTime: number;
    constructor(props: Props) {
        super(props);
        this.blurTime = new Date().getTime();

        if (this.props.mfaRequired) {
            this.props.history.push('/mfa/setup');
            return;
        }

        clearInterval(wakeUpInterval);

        wakeUpInterval = window.setInterval(() => {
            const currentTime = (new Date()).getTime();
            if (currentTime > (lastTime + WAKEUP_THRESHOLD)) { // ignore small delays
                console.log('computer woke up - fetching latest'); //eslint-disable-line no-console
                reconnect(false);
            }
            lastTime = currentTime;
        }, WAKEUP_CHECK_INTERVAL);

        const team = this.updateCurrentTeam(this.props);

        this.state = {
            team,
            finishedFetchingChannels: false,
            prevTeam: this.props.match.params.team,
            teamsList: this.props.teamsList,
        };

        LocalStorageStore.setTeamIdJoinedOnLoad(null);

        if (!team) {
            this.joinTeam(this.props, true);
        }
    }

    static getDerivedStateFromProps(nextProps: Props, state: State) {
        if (state.prevTeam !== nextProps.match.params.team) {
            const team = nextProps.teamsList ? nextProps.teamsList.find((teamObj: Team) =>
                teamObj.name === nextProps.match.params.team) : null;
            return {
                prevTeam: nextProps.match.params.team,
                team: (team || null),
            };
        }
        return {prevTeam: nextProps.match.params.team};
    }

    public componentDidMount() {
        startPeriodicStatusUpdates();
        this.fetchAllTeams();

        // Set up tracking for whether the window is active
        window.isActive = true;

        if (UserAgent.isIosSafari()) {
            // Use iNoBounce to prevent scrolling past the boundaries of the page
            iNoBounce.enable();
        }

        window.addEventListener('focus', this.handleFocus);
        window.addEventListener('blur', this.handleBlur);
        window.addEventListener('keydown', this.onShortcutKeyDown);
    }

    componentDidUpdate(prevProps: Props) {
        if (this.props.match.params.team !== prevProps.match.params.team) {
            if (this.state.team) {
                this.initTeam(this.state.team);
            }
            if (!this.state.team) {
                this.joinTeam(this.props);
            }
        }
    }

    componentWillUnmount() {
        window.isActive = false;
        stopPeriodicStatusUpdates();
        if (UserAgent.isIosSafari()) {
            iNoBounce.disable();
        }

        clearInterval(wakeUpInterval);
        window.removeEventListener('focus', this.handleFocus);
        window.removeEventListener('blur', this.handleBlur);
        window.removeEventListener('keydown', this.onShortcutKeyDown);
    }

    handleBlur = () => {
        window.isActive = false;
        this.blurTime = new Date().getTime();
        if (this.props.currentUser) {
            this.props.actions.viewChannel('');
        }
    }

    handleFocus = () => {
        if (this.props.selectedThreadId) {
            window.isActive = true;
        }
        if (this.props.currentChannelId) {
            this.props.actions.markChannelAsReadOnFocus(this.props.currentChannelId);
            window.isActive = true;
        }
        if (Date.now() - this.blurTime > UNREAD_CHECK_TIME_MILLISECONDS && this.props.currentTeamId) {
            this.props.actions.fetchMyChannelsAndMembersREST(this.props.currentTeamId);
        }
    }

    joinTeam = async (props: Props, firstLoad = false) => {
        // skip reserved teams
        if (Constants.RESERVED_TEAM_NAMES.includes(props.match.params.team)) {
            return;
        }

        const {data: team} = await this.props.actions.getTeamByName(props.match.params.team);
        if (team && team.delete_at === 0) {
            const {error} = await props.actions.addUserToTeam(team.id, props.currentUser && props.currentUser.id);
            if (error) {
                props.history.push('/error?type=team_not_found');
            } else {
                if (firstLoad) {
                    LocalStorageStore.setTeamIdJoinedOnLoad(team.id);
                }
                this.setState({team});
                this.initTeam(team);
            }
        } else {
            props.history.push('/error?type=team_not_found');
        }
    }

    initTeam = (team: Team) => {
        if (team.id !== this.props.previousTeamId) {
            GlobalActions.emitCloseRightHandSide();
        }

        // If current team is set, then this is not first load
        // The first load action pulls team unreads
        this.props.actions.getMyTeamUnreads(this.props.collapsedThreads);
        this.props.actions.selectTeam(team);
        this.props.actions.setPreviousTeamId(team.id);

        if (this.props.currentUser && isGuest(this.props.currentUser.roles)) {
            this.setState({finishedFetchingChannels: false});
        }
        this.props.actions.fetchMyChannelsAndMembersREST(team.id).then(
            () => {
                this.setState({
                    finishedFetchingChannels: true,
                });
            },
        );
        this.props.actions.loadStatusesForChannelAndSidebar();

        if (this.props.license &&
            this.props.license.IsLicensed === 'true' &&
            (this.props.license.LDAPGroups === 'true' || this.props.isCustomGroupsEnabled)) {
            if (this.props.currentUser) {
                this.props.actions.getGroupsByUserIdPaginated(this.props.currentUser.id, false, 0, 60, true);
            }

            if (this.props.license.LDAPGroups === 'true') {
                this.props.actions.getAllGroupsAssociatedToChannelsInTeam(team.id, true);
            }

            if (team.group_constrained && this.props.license.LDAPGroups === 'true') {
                this.props.actions.getAllGroupsAssociatedToTeam(team.id, true);
            } else {
                this.props.actions.getGroups(false, 0, 60);
            }
        }

        return team;
    }

    fetchAllTeams = () => {
        this.props.actions.fetchAllMyTeamsChannelsAndChannelMembersREST();
    }

    updateCurrentTeam = (props: Props) => {
        // First check to make sure you're in the current team
        // for the current url.
        const team = props.teamsList ? props.teamsList.find((teamObj) => teamObj.name === props.match.params.team) : null;
        if (team) {
            this.initTeam(team);
            return team;
        }
        return null;
    }

    onShortcutKeyDown = (e: KeyboardEvent) => {
        if (e.shiftKey && Utils.cmdOrCtrlPressed(e) && Utils.isKeyPressed(e, Constants.KeyCodes.L)) {
            const sidebar = document.getElementById('sidebar-right');
            if (sidebar) {
                if (sidebar.className.match('sidebar--right sidebar--right--expanded move--left')) {
                    const replyTextbox = document.getElementById('reply_textbox');
                    if (replyTextbox) {
                        replyTextbox.focus();
                    }
                } else {
                    const postTextbox = document.getElementById('post_textbox');
                    if (postTextbox) {
                        postTextbox.focus();
                    }
                }
            }
        }
    }

    render() {
        if (this.state.team === null) {
            return <div/>;
        }

        return (
            <Switch>
                <Route
                    path={'/:team/integrations'}
                    component={BackstageController}
                />
                <Route
                    path={'/:team/emoji'}
                    component={BackstageController}
                />
                {this.props.plugins?.map((plugin: any) => (
                    <Route
                        key={plugin.id}
                        path={'/:team/' + plugin.route}
                        render={() => (
                            <Pluggable
                                pluggableName={'NeedsTeamComponent'}
                                pluggableId={plugin.id}
                            />
                        )}
                    />
                ))}
                <Route
                    render={() => (
                        <ChannelController
                            shouldShowAppBar={this.props.shouldShowAppBar}
                            fetchingChannels={!this.state.finishedFetchingChannels}
                        />
                    )}
                />
            </Switch>
        );
    }
}
