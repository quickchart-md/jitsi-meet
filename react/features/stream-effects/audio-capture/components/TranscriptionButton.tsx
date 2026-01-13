import React, { ReactNode } from 'react';
import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconTranscribe, IconTranscribeOn } from '../../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import ToolboxItem from '../../../base/toolbox/components/ToolboxItem';
import { toggleTranscription } from '../actions';
import AudioStreamCapture from '../AudioStreamCapture';

interface IProps extends AbstractButtonProps {

    /**
     * Whether transcription is currently enabled.
     */
    _transcriptionEnabled: boolean;

    /**
     * Whether audio capture is active (button only visible when capturing).
     */
    _isCapturing: boolean;
}

/**
 * Implementation of a button for toggling transcription on/off.
 */
class TranscriptionButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.transcription';
    override toggledAccessibilityLabel = 'toolbar.accessibilityLabel.transcription';
    override label = 'toolbar.startTranscription';
    override toggledLabel = 'toolbar.stopTranscription';
    override tooltip = 'toolbar.startTranscription';
    override toggledTooltip = 'toolbar.stopTranscription';
    override icon = IconTranscribe;
    override toggledIcon = IconTranscribeOn;

    /**
     * Indicates whether this button is in toggled state or not.
     * Returns true when transcription is enabled to show highlighted/toggled state.
     * Defaults to true to prevent gray flash before Redux state is connected.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props._transcriptionEnabled !== false;
    }

    /**
     * Indicates whether this button is disabled or not.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isDisabled() {
        return !this.props._isCapturing;
    }

    /**
     * Handles clicking the button, and toggles transcription.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, _transcriptionEnabled } = this.props;

        sendAnalytics(createToolbarEvent(
            'toggle.transcription',
            {
                enable: !_transcriptionEnabled
            }));

        dispatch(toggleTranscription());
    }

    /**
     * Implements React's {@link Component#render()}.
     * Overrides to add custom pulsing class when transcription is active.
     *
     * @inheritdoc
     * @returns {ReactNode}
     */
    override render(): ReactNode {
        const { _transcriptionEnabled } = this.props;
        // Default to showing pulse (red) unless explicitly disabled
        // This prevents gray flash on initial render before Redux state is connected
        const customClass = _transcriptionEnabled !== false ? 'transcription-active-pulse' : '';

        const props: any = {
            ...this.props,
            accessibilityLabel: this._getAccessibilityLabel(),
            customClass,
            elementAfter: this._getElementAfter(),
            icon: this._getIcon(),
            label: this._getLabel(),
            labelProps: this.labelProps,
            styles: this._getStyles(),
            toggled: this._isToggled(),
            tooltip: this._getTooltip()
        };

        return (
            <ToolboxItem
                disabled = { this._isDisabled() }
                onClick = { this._onClick }
                onKeyDown = { this._onKeyDown }
                { ...props } />
        );
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
const mapStateToProps = (state: IReduxState) => {
    const audioCapture = AudioStreamCapture.getInstance();

    return {
        _transcriptionEnabled: state['features/audio-capture']?.transcriptionEnabled ?? true,
        _isCapturing: audioCapture.getIsCapturing(),
        visible: true
    };
};

export default translate(connect(mapStateToProps)(TranscriptionButton));
