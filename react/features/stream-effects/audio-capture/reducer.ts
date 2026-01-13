import ReducerRegistry from '../../base/redux/ReducerRegistry';

import { SET_TRANSCRIPTION_ENABLED } from './actionTypes';

export interface IAudioCaptureState {
    transcriptionEnabled: boolean;
}

const DEFAULT_STATE: IAudioCaptureState = {
    transcriptionEnabled: true
};

ReducerRegistry.register<IAudioCaptureState>(
    'features/audio-capture',
    (state = DEFAULT_STATE, action): IAudioCaptureState => {
        switch (action.type) {
        case SET_TRANSCRIPTION_ENABLED:
            return {
                ...state,
                transcriptionEnabled: action.enabled
            };

        default:
            return state;
        }
    }
);
