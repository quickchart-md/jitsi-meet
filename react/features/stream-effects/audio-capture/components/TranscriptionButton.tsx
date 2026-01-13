import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconTranscribe, IconTranscribeOn } from '../../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
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
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props._transcriptionEnabled;
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
