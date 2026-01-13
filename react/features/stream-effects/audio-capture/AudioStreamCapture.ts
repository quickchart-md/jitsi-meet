/**
 * AudioStreamCapture - Captures all conference audio and sends chunks to parent window.
 * This enables parent applications (embedding Jitsi via iframe) to access audio for
 * transcription, recording, or other processing.
 *
 * Sends:
 * - jitsi-audio-chunk: Compressed audio chunks (WebM/Opus) for transcription
 * - jitsi-audio-levels: Real-time audio levels per participant for waveforms
 * - jitsi-voice-activity: Voice activity detection events
 * - jitsi-audio-capture-status: Capture status updates
 * - jitsi-transcription-status: Transcription enabled/disabled status
 */

import { IReduxState } from '../../app/types';
import { MEDIA_TYPE } from '../../base/media/constants';
import logger from '../../base/media/logger';

interface AudioCaptureOptions {
    /** Time slice in ms for MediaRecorder chunks (default: 1000) */
    timeSlice?: number;
    /** Audio MIME type (default: 'audio/webm;codecs=opus') */
    mimeType?: string;
    /** Include local audio (default: true) */
    includeLocal?: boolean;
    /** Include remote audio (default: true) */
    includeRemote?: boolean;
    /** Enable audio level monitoring (default: true) */
    enableLevels?: boolean;
    /** Audio level update interval in ms (default: 100) */
    levelInterval?: number;
    /** Enable voice activity detection (default: true) */
    enableVAD?: boolean;
    /** VAD threshold (default: 0.01) */
    vadThreshold?: number;
    /** Send raw PCM data instead of compressed audio (default: false) */
    rawPCM?: boolean;
    /** Buffer size for raw PCM capture (default: 4096) */
    pcmBufferSize?: number;
}

interface AudioChunkMessage {
    type: 'audio-chunk';
    data: ArrayBuffer;
    timestamp: number;
    mimeType: string;
}

interface PCMFrameMessage {
    type: 'pcm-frame';
    data: ArrayBuffer; // Float32Array as ArrayBuffer
    sampleRate: number;
    timestamp: number;
    participantId: string;
    participantName: string;
}

interface AudioLevelMessage {
    type: 'audio-levels';
    levels: { [participantId: string]: number };
    timestamp: number;
}

interface VoiceActivityMessage {
    type: 'voice-activity';
    participantId: string;
    speaking: boolean;
    timestamp: number;
}

type StoreType = {
    getState: () => IReduxState;
    subscribe: (listener: () => void) => () => void;
};

interface TrackInfo {
    participantId: string;
    displayName: string;
    sourceNode: MediaStreamAudioSourceNode;
    analyserNode: AnalyserNode;
    scriptProcessor?: ScriptProcessorNode;
    lastLevel: number;
    isSpeaking: boolean;
    vadTimeout: number | null;
}

/**
 * Singleton class to capture and stream conference audio to parent window.
 */
class AudioStreamCapture {
    private static instance: AudioStreamCapture | null = null;

    private audioContext: AudioContext | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private destinationNode: MediaStreamAudioDestinationNode | null = null;
    private tracks: Map<string, TrackInfo> = new Map();
    private isCapturing: boolean = false;
    private isTranscriptionEnabled: boolean = true;
    private options: AudioCaptureOptions = {};
    private store: StoreType | null = null;
    private unsubscribe: (() => void) | null = null;
    private previousTrackIds: Set<string> = new Set();
    private levelInterval: number | null = null;

    private static readonly VAD_SILENCE_DURATION = 500; // ms before marking as not speaking

    private constructor() {}

    static getInstance(): AudioStreamCapture {
        if (!AudioStreamCapture.instance) {
            AudioStreamCapture.instance = new AudioStreamCapture();
        }
        return AudioStreamCapture.instance;
    }

    /**
     * Set the Redux store for track management.
     */
    setStore(store: StoreType): void {
        this.store = store;
    }

    /**
     * Start capturing audio from all conference participants.
     */
    async start(options: AudioCaptureOptions = {}): Promise<void> {
        if (this.isCapturing) {
            logger.warn('[AudioStreamCapture] Already capturing');
            return;
        }

        this.options = {
            timeSlice: 1000,
            mimeType: 'audio/webm;codecs=opus',
            includeLocal: true,
            includeRemote: true,
            enableLevels: true,
            levelInterval: 100,
            enableVAD: true,
            vadThreshold: 0.01,
            rawPCM: false,
            pcmBufferSize: 4096,
            ...options
        };

        try {
            // Create audio context and destination
            this.audioContext = new AudioContext();
            this.destinationNode = this.audioContext.createMediaStreamDestination();

            // Only use MediaRecorder if not in raw PCM mode
            if (!this.options.rawPCM) {
                // Check MediaRecorder support for the requested MIME type
                let mimeType = this.options.mimeType!;
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    // Fallback to basic webm
                    mimeType = 'audio/webm';
                    if (!MediaRecorder.isTypeSupported(mimeType)) {
                        throw new Error('MediaRecorder does not support audio/webm');
                    }
                }

                // Create MediaRecorder for compressed audio chunks
                this.mediaRecorder = new MediaRecorder(this.destinationNode.stream, {
                    mimeType,
                    audioBitsPerSecond: 128000
                });

                // Handle data chunks
                this.mediaRecorder.ondataavailable = async (event) => {
                    if (event.data.size > 0) {
                        const arrayBuffer = await event.data.arrayBuffer();
                        this.sendToParent('jitsi-audio-chunk', {
                            type: 'audio-chunk',
                            data: arrayBuffer,
                            timestamp: Date.now(),
                            mimeType
                        });
                    }
                };

                this.mediaRecorder.onerror = (event) => {
                    logger.error('[AudioStreamCapture] MediaRecorder error:', event);
                    this.sendStatusToParent('error', 'MediaRecorder error');
                };

                // Start recording
                this.mediaRecorder.start(this.options.timeSlice);
            }

            this.isCapturing = true;

            // Start audio level monitoring
            if (this.options.enableLevels) {
                this.startLevelMonitoring();
            }

            // Subscribe to store changes for track management
            if (this.store) {
                this.syncTracksFromStore();
                this.unsubscribe = this.store.subscribe(() => {
                    this.syncTracksFromStore();
                });
            }

            logger.info('[AudioStreamCapture] Started capturing audio');
            this.sendStatusToParent('started');

        } catch (error) {
            logger.error('[AudioStreamCapture] Failed to start:', error);
            this.sendStatusToParent('error', (error as Error).message);
            this.cleanup();
            throw error;
        }
    }

    /**
     * Start monitoring audio levels for all tracks.
     */
    private startLevelMonitoring(): void {
        if (this.levelInterval) {
            return;
        }

        this.levelInterval = window.setInterval(() => {
            if (!this.isCapturing) {
                return;
            }

            const levels: { [participantId: string]: number } = {};

            this.tracks.forEach((trackInfo, trackId) => {
                // Get audio level using time-domain data (better for voice detection)
                const analyser = trackInfo.analyserNode;
                const dataArray = new Float32Array(analyser.fftSize);
                analyser.getFloatTimeDomainData(dataArray);

                // Calculate RMS (root mean square) for accurate volume level
                let sumSquares = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sumSquares += dataArray[i] * dataArray[i];
                }
                const rms = Math.sqrt(sumSquares / dataArray.length);

                // Scale RMS to 0-1 range (RMS of full-scale sine is ~0.707)
                // Multiply by ~1.4 to normalize, then clamp
                const level = Math.min(1, rms * 1.4);
                trackInfo.lastLevel = level;
                levels[trackInfo.participantId] = level;

                // Voice activity detection
                if (this.options.enableVAD) {
                    this.handleVAD(trackInfo, level > this.options.vadThreshold!);
                }
            });

            // Send levels to parent
            if (Object.keys(levels).length > 0) {
                this.sendToParent('jitsi-audio-levels', {
                    type: 'audio-levels',
                    levels,
                    timestamp: Date.now()
                });
            }
        }, this.options.levelInterval);
    }

    /**
     * Handle Voice Activity Detection state changes.
     */
    private handleVAD(trackInfo: TrackInfo, currentlySpeaking: boolean): void {
        if (currentlySpeaking) {
            // Clear any pending silence timeout
            if (trackInfo.vadTimeout) {
                clearTimeout(trackInfo.vadTimeout);
                trackInfo.vadTimeout = null;
            }

            // Mark as speaking if not already
            if (!trackInfo.isSpeaking) {
                trackInfo.isSpeaking = true;
                this.sendToParent('jitsi-voice-activity', {
                    type: 'voice-activity',
                    participantId: trackInfo.participantId,
                    speaking: true,
                    timestamp: Date.now()
                });
            }
        } else {
            // Start silence timeout if not already waiting
            if (trackInfo.isSpeaking && !trackInfo.vadTimeout) {
                trackInfo.vadTimeout = window.setTimeout(() => {
                    trackInfo.isSpeaking = false;
                    trackInfo.vadTimeout = null;
                    this.sendToParent('jitsi-voice-activity', {
                        type: 'voice-activity',
                        participantId: trackInfo.participantId,
                        speaking: false,
                        timestamp: Date.now()
                    });
                }, AudioStreamCapture.VAD_SILENCE_DURATION);
            }
        }
    }

    /**
     * Sync audio tracks from the Redux store.
     */
    private syncTracksFromStore(): void {
        if (!this.store || !this.isCapturing) {
            return;
        }

        const state = this.store.getState();
        const tracks = state['features/base/tracks'] || [];
        const participantsState = state['features/base/participants'];
        const currentTrackIds = new Set<string>();

        // Add new audio tracks
        tracks.forEach((track: any) => {
            if (track.mediaType !== MEDIA_TYPE.AUDIO) {
                return;
            }

            if (!track.jitsiTrack) {
                return;
            }

            // Check options
            if (track.local && !this.options.includeLocal) {
                return;
            }
            if (!track.local && !this.options.includeRemote) {
                return;
            }

            const trackId = track.local ? 'local-audio' : `remote-${track.participantId}`;
            currentTrackIds.add(trackId);

            // Skip if already added
            if (this.tracks.has(trackId)) {
                return;
            }

            // Get display name from participants state
            // participantsState has: { local, localScreenShare, remote (Map) }
            let displayName = 'Unknown';
            if (track.local) {
                displayName = participantsState?.local?.name || 'You';
            } else if (track.participantId && participantsState?.remote) {
                const remoteParticipant = participantsState.remote.get(track.participantId);
                displayName = remoteParticipant?.name || 'Participant';
            }

            // Get the MediaStream
            const stream = track.jitsiTrack.getOriginalStream?.() || track.jitsiTrack.stream;
            if (stream) {
                this.addTrack(trackId, track.participantId || 'local', displayName, stream);
            }
        });

        // Remove tracks that are no longer present
        this.previousTrackIds.forEach(trackId => {
            if (!currentTrackIds.has(trackId)) {
                this.removeTrack(trackId);
            }
        });

        this.previousTrackIds = currentTrackIds;
    }

    /**
     * Stop capturing audio.
     */
    stop(): void {
        if (!this.isCapturing) {
            return;
        }

        this.cleanup();
        logger.info('[AudioStreamCapture] Stopped capturing audio');
        this.sendStatusToParent('stopped');
    }

    /**
     * Add an audio track to the capture mix.
     */
    addTrack(trackId: string, participantId: string, displayName: string, mediaStream: MediaStream): void {
        if (!this.audioContext || !this.destinationNode) {
            logger.warn('[AudioStreamCapture] Cannot add track - not capturing');
            return;
        }

        if (this.tracks.has(trackId)) {
            logger.warn(`[AudioStreamCapture] Track ${trackId} already added`);
            return;
        }

        try {
            const sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
            const analyserNode = this.audioContext.createAnalyser();
            analyserNode.fftSize = 2048;
            analyserNode.smoothingTimeConstant = 0.8;

            // Connect: source -> analyser
            sourceNode.connect(analyserNode);

            // For compressed audio mode, also connect to destination for mixed recording
            if (!this.options.rawPCM) {
                sourceNode.connect(this.destinationNode);
            }

            let scriptProcessor: ScriptProcessorNode | undefined;

            // For raw PCM mode, create a ScriptProcessorNode to capture raw audio frames
            if (this.options.rawPCM) {
                const bufferSize = this.options.pcmBufferSize || 4096;
                scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

                scriptProcessor.onaudioprocess = (event) => {
                    if (!this.isCapturing) return;

                    // Only send PCM frames when transcription is enabled
                    if (!this.isTranscriptionEnabled) return;

                    const inputData = event.inputBuffer.getChannelData(0);
                    const frame = new Float32Array(inputData.length);
                    frame.set(inputData);

                    // Send raw PCM frame to parent
                    this.sendToParent('jitsi-pcm-frame', {
                        type: 'pcm-frame',
                        data: frame.buffer,
                        sampleRate: this.audioContext!.sampleRate,
                        timestamp: Date.now(),
                        participantId,
                        participantName: displayName
                    });
                };

                // Connect: analyser -> scriptProcessor -> destination (required for it to process)
                analyserNode.connect(scriptProcessor);
                scriptProcessor.connect(this.audioContext.destination);
            }

            const trackInfo: TrackInfo = {
                participantId,
                displayName,
                sourceNode,
                analyserNode,
                scriptProcessor,
                lastLevel: 0,
                isSpeaking: false,
                vadTimeout: null
            };

            this.tracks.set(trackId, trackInfo);
            logger.info(`[AudioStreamCapture] Added track: ${trackId} (${displayName})`);
        } catch (error) {
            logger.error(`[AudioStreamCapture] Failed to add track ${trackId}:`, error);
        }
    }

    /**
     * Remove an audio track from the capture mix.
     */
    removeTrack(trackId: string): void {
        const trackInfo = this.tracks.get(trackId);
        if (trackInfo) {
            // Clear VAD timeout
            if (trackInfo.vadTimeout) {
                clearTimeout(trackInfo.vadTimeout);
            }

            try {
                trackInfo.sourceNode.disconnect();
                trackInfo.analyserNode.disconnect();
                if (trackInfo.scriptProcessor) {
                    trackInfo.scriptProcessor.disconnect();
                }
            } catch (e) {
                // Ignore disconnect errors
            }
            this.tracks.delete(trackId);
            logger.info(`[AudioStreamCapture] Removed track: ${trackId}`);
        }
    }

    /**
     * Check if currently capturing.
     */
    getIsCapturing(): boolean {
        return this.isCapturing;
    }

    /**
     * Clean up resources.
     */
    private cleanup(): void {
        // Stop level monitoring
        if (this.levelInterval) {
            clearInterval(this.levelInterval);
            this.levelInterval = null;
        }

        // Unsubscribe from store
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }

        // Stop MediaRecorder
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.mediaRecorder = null;

        // Disconnect all tracks
        this.tracks.forEach((trackInfo) => {
            if (trackInfo.vadTimeout) {
                clearTimeout(trackInfo.vadTimeout);
            }
            try {
                trackInfo.sourceNode.disconnect();
                trackInfo.analyserNode.disconnect();
                if (trackInfo.scriptProcessor) {
                    trackInfo.scriptProcessor.disconnect();
                }
            } catch (e) {
                // Ignore
            }
        });
        this.tracks.clear();
        this.previousTrackIds.clear();

        // Close audio context
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        this.audioContext = null;
        this.destinationNode = null;

        this.isCapturing = false;
    }

    /**
     * Enable transcription - resumes sending PCM frames for transcription.
     */
    enableTranscription(): void {
        if (!this.isCapturing) {
            logger.warn('[AudioStreamCapture] Cannot enable transcription - not capturing');
            return;
        }

        this.isTranscriptionEnabled = true;
        logger.info('[AudioStreamCapture] Transcription enabled');
        this.sendTranscriptionStatusToParent(true);
    }

    /**
     * Disable transcription - stops sending PCM frames but keeps audio levels/VAD working.
     * Sends a flush signal to parent so pending audio can be transcribed.
     */
    disableTranscription(): void {
        if (!this.isCapturing) {
            logger.warn('[AudioStreamCapture] Cannot disable transcription - not capturing');
            return;
        }

        this.isTranscriptionEnabled = false;
        logger.info('[AudioStreamCapture] Transcription disabled');
        this.sendTranscriptionStatusToParent(false);
    }

    /**
     * Toggle transcription on/off.
     */
    toggleTranscription(): boolean {
        if (this.isTranscriptionEnabled) {
            this.disableTranscription();
        } else {
            this.enableTranscription();
        }
        return this.isTranscriptionEnabled;
    }

    /**
     * Check if transcription is currently enabled.
     */
    getIsTranscriptionEnabled(): boolean {
        return this.isTranscriptionEnabled;
    }

    /**
     * Send message to parent window.
     */
    private sendToParent(messageType: string, data: any): void {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                ...data,
                messageType
            }, '*');
        }
    }

    /**
     * Send status update to parent window.
     */
    private sendStatusToParent(status: 'started' | 'stopped' | 'error', error?: string): void {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'jitsi-audio-capture-status',
                status,
                error
            }, '*');
        }
    }

    /**
     * Send transcription status update to parent window.
     */
    private sendTranscriptionStatusToParent(enabled: boolean): void {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'jitsi-transcription-status',
                enabled,
                timestamp: Date.now()
            }, '*');
        }
    }
}

export default AudioStreamCapture;
