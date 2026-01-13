import { SET_TRANSCRIPTION_ENABLED } from './actionTypes';
import AudioStreamCapture from './AudioStreamCapture';

/**
 * Action to set transcription enabled state.
 *
 * @param {boolean} enabled - Whether transcription is enabled.
 * @returns {Object}
 */
export function setTranscriptionEnabled(enabled: boolean) {
    const audioCapture = AudioStreamCapture.getInstance();

    if (enabled) {
        audioCapture.enableTranscription();
    } else {
        audioCapture.disableTranscription();
    }

    return {
        type: SET_TRANSCRIPTION_ENABLED,
        enabled
    };
}

/**
 * Action to toggle transcription.
 *
 * @returns {Function}
 */
export function toggleTranscription() {
    return (dispatch: Function, getState: Function) => {
        const state = getState();
        const currentEnabled = state['features/audio-capture']?.transcriptionEnabled ?? true;

        dispatch(setTranscriptionEnabled(!currentEnabled));
    };
}
