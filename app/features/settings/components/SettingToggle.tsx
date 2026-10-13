
import React from 'react';
import { connect } from 'react-redux';
import { AnyAction, Dispatch } from 'redux';

import type { ISettingsState, IState } from '../../../types';

import ToggleWithLabel from './ToggleWithLabel';

interface IProps {
    defaultValue?: boolean;
    dispatch: Dispatch;
    label?: string;
    settingChangeEvent?: (value: boolean) => AnyAction;
    settingName: keyof ISettingsState;
    value?: boolean;
}

/**
 * Maps (parts of) the redux state to the React props.
 *
 * @param {Object} state - The redux state.
 * @param {Object} ownProps - The props of the redux wrapper component.
 * @returns {Object} A props object including the current value of the setting.
 */
const mapStateToProps = (
        state: IState, ownProps: { defaultValue?: boolean; settingName: keyof ISettingsState; }) => {
    return {
        // The persisted settings of an older version lack newer keys: fall back to the default.
        value: (state.settings[ownProps.settingName] ?? ownProps.defaultValue) as boolean,
        ...ownProps
    };
};

/**
 * A component to control a single boolean redux setting.
 *
 * @param {Object} props - The props provided by mapStateToProps.
 * @returns {Object} A rendered toggle component with correct state.
 */
function SettingToggle(props: IProps) {
    const onChange = () => props.dispatch(props.settingChangeEvent!(!props.value));

    return (
        <ToggleWithLabel
            isDefaultChecked = { props.value }
            label = { props.label }
            onChange = { onChange }
            value = { props.value } />
    );
}

export default connect(mapStateToProps)(SettingToggle);
