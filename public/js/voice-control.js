/**
 * Voice Control Utility
 * Handles Text-to-Speech (TTS) and Speech-to-Text (STT) interactions
 */
class VoiceControl {
    constructor() {
        this.synth = window.speechSynthesis;
        this.recognition = null;
        this.isListening = false;
        this.supportsSpeechRecognition = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
        this.voices = [];
        const storedSetting = localStorage.getItem('voiceEnabled');
        this.voiceEnabled = storedSetting === null ? true : storedSetting === 'true'; // Default to true if not set

        // Enforce Server TTS (Google Cloud) for all users
        this.useServerTTS = true;

        this.initSpeechRecognition();
        this.loadVoices();

        // Chrome loads voices asynchronously
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = () => this.loadVoices();
        }
    }

    /**
     * Initialize Speech Recognition API
     */
    initSpeechRecognition() {
        if (!this.supportsSpeechRecognition) {
            console.warn('Speech Recognition API not supported in this browser.');
            this.recognition = null;
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            this.supportsSpeechRecognition = false;
            console.warn('Speech Recognition API not supported in this browser.');
            return;
        }

        try {
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.lang = 'en-US';
            this.recognition.interimResults = true;
            this.recognition.maxAlternatives = 1;
        } catch (error) {
            this.supportsSpeechRecognition = false;
            this.recognition = null;
            console.warn('Failed to initialize Speech Recognition:', error);
        }
    }

    /**
     * Load available voices
     */
    loadVoices() {
        this.voices = this.synth.getVoices();
    }

    /**
     * Toggle voice notifications
     */
    toggleVoiceNotifications(enabled) {
        this.voiceEnabled = enabled;
        localStorage.setItem('voiceEnabled', enabled); // Save to storage

        if (!enabled) {
            this.synth.cancel(); // Stop speaking immediately
        }
    }



    /**
     * Speak text using TTS
     * @param {string} text - Text to speak
     * @param {string} [preferredVoice] - Optional preferred voice name or gender
     */
    async speak(text, preferredVoice = null) {
        console.log('Attempting to speak:', text, 'Enabled:', this.voiceEnabled, 'ServerTTS:', this.useServerTTS);
        if (!this.voiceEnabled || !text) return;

        // Cancel current utterance if any
        this.synth.cancel();

        // Use Server-side TTS (Google Cloud) if enabled
        if (this.useServerTTS) {
            try {
                const response = await fetch('/api/user/tts', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        // CSRF token might be needed if not handled by cookie/middleware automatically for this path
                        // Assuming standard session auth covers it or token is available globally
                        'X-CSRF-Token': window.csrfToken
                    },
                    body: JSON.stringify({ text })
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.audioUrl) {
                        const audio = new Audio(data.audioUrl);
                        audio.volume = 1.0;
                        await audio.play();
                        return; // Success, exit function
                    }
                } else {
                    console.warn('Server TTS failed, falling back to local TTS');
                }
            } catch (error) {
                console.error('Error using server TTS:', error);
                // Fallback to local TTS
            }
        }

        // Fallback: Local Browser TTS
        const utterance = new SpeechSynthesisUtterance(text);

        // Select voice
        let voice = null;

        // 1. Try specific preferred voice if provided
        if (preferredVoice) {
            voice = this.voices.find(v => v.name.includes(preferredVoice));
        }

        // 2. Try to find a high-quality female voice
        if (!voice) {
            const preferredNames = ['Google US English', 'Microsoft Zira', 'Samantha', 'Karen', 'Rishi'];
            for (const name of preferredNames) {
                voice = this.voices.find(v => v.name.includes(name));
                if (voice) break;
            }
        }

        // 3. Try any female voice
        if (!voice) {
            voice = this.voices.find(v => v.name.toLowerCase().includes('female'));
        }

        // 4. Fallback to a decent English voice
        if (!voice) {
            voice = this.voices.find(v => v.lang === 'en-US' && !v.name.includes('Google')) || this.voices[0];
        }

        if (voice) {
            utterance.voice = voice;
        }

        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        this.synth.speak(utterance);
    }

    /**
     * Start listening for voice input
     * @param {Function} onResult - Callback for successful result (text)
     * @param {Function} onStart - Callback when listening starts
     * @param {Function} onEnd - Callback when listening ends
     * @param {Function} onError - Callback for errors
     */
    startListening(onResult, onStart, onEnd, onError) {
        if (!this.recognition || !this.supportsSpeechRecognition) {
            if (onError) onError('Voice input needs a Chromium browser (Chrome/Edge) with microphone enabled.');
            return;
        }

        if (this.isListening) {
            this.recognition.stop();
            return;
        }

        this.recognition.onstart = () => {
            this.isListening = true;
            if (onStart) onStart();
        };

        this.recognition.onend = () => {
            this.isListening = false;
            if (onEnd) onEnd();
        };

        this.recognition.onresult = (event) => {
            const transcript = Array.from(event.results || [])
                .map(result => (result[0] && result[0].transcript) || '')
                .join(' ')
                .trim();
            if (transcript && onResult) onResult(transcript);
        };

        this.recognition.onerror = (event) => {
            this.isListening = false;
            let friendlyMessage = 'Voice input encountered an error.';

            switch (event.error) {
                case 'not-allowed':
                case 'service-not-allowed':
                    friendlyMessage = 'Microphone access was blocked. Please allow mic permissions to use voice input.';
                    break;
                case 'network':
                    friendlyMessage = 'Speech service is unavailable right now. Check your connection and try again.';
                    break;
                case 'no-speech':
                    friendlyMessage = 'No speech was detected. Please try again.';
                    break;
                default:
                    friendlyMessage = `Voice input failed: ${event.error}`;
            }

            if (onError) onError(friendlyMessage);
        };

        try {
            this.recognition.start();
        } catch (error) {
            this.isListening = false;
            if (error.name === 'NotAllowedError') {
                if (onError) onError('Microphone permission is required to start voice input.');
            } else if (error.name === 'InvalidStateError') {
                if (onError) onError('Voice input was already running. Please try again.');
            } else if (onError) {
                onError('Unable to start voice input. Please try again.');
            }

            // Reset the recognition instance in case it was left in a bad state
            this.initSpeechRecognition();
        }
    }

    /**
     * Stop listening
     */
    stopListening() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
            this.isListening = false;
        }
    }
}

// Export instance
window.voiceControl = new VoiceControl();
