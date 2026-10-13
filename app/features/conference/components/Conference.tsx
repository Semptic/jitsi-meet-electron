
import {
    initPopupsConfigurationRender,
    setupPictureInPictureRender,
    setupPowerMonitorRender,
    setupRemoteControlRender,
    setupScreenSharingRender
} from '@jitsi/electron-sdk/renderer';
import React, { Component } from 'react';
import { connect } from 'react-redux';
import { Dispatch } from 'redux';

import i18n from '../../../i18n';
import type { IConference, IState } from '../../../types';
import config from '../../config';
import { setupMultitrackRecordingRender } from '../../multitrack-recording/renderer';
import { getSetting } from '../../settings';
import Spinner from '../../shared/components/Spinner';
import { parseURLParams } from '../../utils/parseURLParams';
import { conferenceEnded, conferenceJoined } from '../actions';
import JitsiMeetExternalAPI from '../external_api';
import { LoadingIndicator, Wrapper } from '../styled';

interface IProps {
    _alwaysOnTopWindowEnabled?: boolean;
    _disableAGC?: boolean;
    _serverTimeout?: number;
    _serverURL?: string;
    _useEmbeddedClient?: boolean;
    conference: IConference;
    dispatch: Dispatch;
}

interface IConferenceState {
    isLoading: boolean;
}

/**
 * Conference component.
 */
class Conference extends Component<IProps, IConferenceState> {
    _ref = React.createRef<HTMLDivElement>();
    _api?: JitsiMeetExternalAPI;
    _conference!: { room: string; serverURL: string; };
    _iframeLoaded?: boolean;
    _loadId = 0;

    /**
     * Initializes a new {@code Conference} instance.
     *
     * @inheritdoc
     */
    constructor(props: IProps) {
        super(props);

        this.state = {
            isLoading: true
        };

        this._ref = React.createRef();

        this._onIframeLoad = this._onIframeLoad.bind(this);
        this._onVideoConferenceEnded = this._onVideoConferenceEnded.bind(this);
    }

    /**
     * Attach the script to this component.
     *
     * @returns {void}
     */
    componentDidMount() {
        const room = this.props.conference.room;
        const serverURL = this.props.conference.serverURL
            || this.props._serverURL
            || config.defaultServerURL;

        this._conference = {
            room,
            serverURL
        };

        this._loadConference().catch(error => console.error('Loading the conference failed', error));
    }

    /**
     * Remove conference on unmounting.
     *
     * @returns {void}
     */
    componentWillUnmount() {
        // Abandon a load that is still waiting for the embedded client server.
        this._loadId++;

        if (this._api) {
            this._api.dispose();
        }
    }

    /**
     * Handle joining another another meeing while in one.
     *
     * @param {Object} prevProps - The previous props.
     * @returns {void}
     */
    componentDidUpdate(prevProps: IProps) {
        const prevConference = prevProps.conference || {};
        const currentConference = this.props.conference || {};

        if (prevConference.room !== currentConference.room
            || prevConference.serverURL !== currentConference.serverURL) {

            // Simulate a re-mount so the new meeting is joined.
            this._iframeLoaded = false;
            this.componentWillUnmount();
            this.componentDidMount();
        }
    }

    /**
     * Implements React's {@link Component#render()}.
     *
     * @returns {ReactElement}
     */
    render() {
        return (
            <Wrapper innerRef = { this._ref }>
                {this._maybeRenderLoadingIndicator()}
            </Wrapper>
        );
    }

    /**
     * Load the conference by creating the iframe element in this component
     * and attaching utils from jitsi-meet-electron-utils.
     *
     * @returns {Promise<void>}
     */
    async _loadConference() {
        const loadId = this._loadId;
        const appProtocolSurplus = `${config.appProtocolPrefix}://`;

        // replace the custom url with https, otherwise new URL() raises 'Invalid URL'.
        if (this._conference.serverURL.startsWith(appProtocolSurplus)) {
            this._conference.serverURL = this._conference.serverURL.replace(appProtocolSurplus, 'https://');
        }
        const url = new URL(this._conference.room, this._conference.serverURL);
        const roomName = url.pathname.split('/').pop();
        let host = this._conference.serverURL.replace(/https?:\/\//, '');
        let embeddedOrigin: string | undefined;

        if (this.props._useEmbeddedClient) {
            // The meeting then loads from a local server that serves the bundled (patched) web
            // client and proxies everything else to the real server, whose URL stays what the
            // user sees and what the recent list keeps.
            embeddedOrigin = await this._resolveEmbeddedOrigin(this._conference.serverURL);

            if (loadId !== this._loadId) {
                return;
            }
            if (embeddedOrigin) {
                // Keep a tenant path (https://server/tenant) of the real server.
                host = embeddedOrigin + new URL(this._conference.serverURL).pathname.replace(/\/+$/, '');
            }
        }
        const searchParameters = Object.fromEntries(url.searchParams);
        const hashParameters = parseURLParams(url);

        const { jwt: jwtFromSearch, ...restSearchParameters } = searchParameters;
        const locale = { lng: i18n.language };
        const urlParameters = {
            ...restSearchParameters,
            ...locale
        };


        const configOverwrite: Record<string, any> = {
            enableCalendarIntegration: false,
            disableAGC: this.props._disableAGC,
            prejoinConfig: {
                enabled: true
            }
        };

        const interfaceConfigOverwrite = {
            SHOW_CHROME_EXTENSION_BANNER: false
        };
        let jwt = jwtFromSearch;

        Object.entries(hashParameters).forEach(([ key, value ]) => {
            if (key.startsWith('config.')) {
                const configKey = key.substring('config.'.length);

                configOverwrite[configKey] = value;
            } else if (key === 'jwt') {
                jwt = value;
            }
        });

        const options = {
            configOverwrite,
            interfaceConfigOverwrite,
            jwt,
            parentNode: this._ref.current,
            roomName,
            sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-downloads'
        };

        this._api = new JitsiMeetExternalAPI(host, {
            ...options,
            ...urlParameters
        });

        // This event is fired really early, at the same time as 'ready', but has been
        // around for longer.
        // TODO: remove after a while. -saghul
        this._api.on('browserSupport', this._onIframeLoad);

        this._api.on('suspendDetected', this._onVideoConferenceEnded);
        this._api.on('readyToClose', this._onVideoConferenceEnded);
        this._api.on('pipLeft', () => {
            window.jitsiElectronApp.ipc.send('restore-meeting-window');
        });
        this._api.on('videoConferenceJoined',
            () => {
                this.props.dispatch(conferenceJoined(this._conference));
            }
        );

        // Setup Jitsi Meet Electron SDK on this renderer. These run in the page
        // ("main world") next to the iframe API and reach the main process only
        // through the window.jitsiElectronSDK bridge installed by the SDK preload.
        initPopupsConfigurationRender(this._api);
        setupScreenSharingRender(this._api);
        setupRemoteControlRender(this._api);
        if (this.props._alwaysOnTopWindowEnabled) {
            setupPictureInPictureRender(this._api);
        }
        setupPowerMonitorRender(this._api);
        setupMultitrackRecordingRender(this._api, embeddedOrigin);
    }

    /**
     * Asks the main process for the embedded client server of the given Jitsi server.
     *
     * @param {string} serverURL - The real server URL.
     * @returns {Promise<string|undefined>} The embedded origin, or undefined to load the server's client.
     */
    async _resolveEmbeddedOrigin(serverURL: string): Promise<string | undefined> {
        try {
            const result = await window.jitsiElectronApp.embeddedClient.resolve(serverURL);

            return result?.origin;
        } catch (error) {
            console.warn('Embedded client unavailable, using the server client', error);

            return undefined;
        }
    }

    /**
     * It renders a loading indicator, if appropriate.
     *
     * @returns {?ReactElement}
     */
    _maybeRenderLoadingIndicator() {
        if (this.state.isLoading) {
            return (
                <LoadingIndicator>
                    <Spinner size = 'large' />
                </LoadingIndicator>
            );
        }
    }

    /**
     * Dispatches conference ended and closes the meeting window (Window 2).
     *
     * @returns {void}
     * @private
     */
    _onVideoConferenceEnded() {
        this.props.dispatch(conferenceEnded(this._conference));
        window.jitsiElectronApp.ipc.send('close-meeting-window');
    }


    /**
     * Sets state of loading to false when iframe has completely loaded.
     *
     * @returns {void}
     */
    _onIframeLoad() {
        if (this._iframeLoaded) {
            // Skip spurious event after meeting close.
            return;
        }

        console.log('IFrame loaded');

        this._iframeLoaded = true;


        this.setState({
            isLoading: false
        });
    }
}

/**
 * Maps (parts of) the redux state to the React props.
 *
 * @param {Object} state - The redux state.
 * @returns {Props}
 */
function _mapStateToProps(state: IState) {
    return {
        _alwaysOnTopWindowEnabled: getSetting(state, 'alwaysOnTopWindowEnabled', true),
        _disableAGC: state.settings.disableAGC,
        _serverURL: state.settings.serverURL,
        _useEmbeddedClient: getSetting(state, 'useEmbeddedClient', true),
        _serverTimeout: state.settings.serverTimeout
    };
}

export default connect(_mapStateToProps)(Conference);
