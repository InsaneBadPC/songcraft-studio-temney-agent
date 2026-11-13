import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionOptions,
} from "expo-speech-recognition";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Linking } from "react-native";

import {
  ASSISTANT_VOICE_AUTOPLAY_KEY,
  ASSISTANT_VOICE_LANG,
  normalizeVoiceTranscript,
  speechTextFromAnswer,
  voiceErrorMessage,
} from "@/lib/assistant-voice";

const recognitionOptions = (onDevice: boolean): ExpoSpeechRecognitionOptions => ({
  lang: ASSISTANT_VOICE_LANG,
  interimResults: true,
  continuous: true,
  maxAlternatives: 1,
  addsPunctuation: true,
  requiresOnDeviceRecognition: onDevice,
});

async function supportsCzechOnDevice(): Promise<boolean> {
  try {
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) return false;
    const supported = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return supported.installedLocales.some((locale) => /^cs([-_]CZ)?$/i.test(locale));
  } catch {
    return false;
  }
}

/**
 * Hlasové ovládání asistenta: české rozpoznávání řeči (přednostně on-device)
 * a české čtení odpovědí. Preferenci auto-přehrávání si pamatuje mezi spuštěními.
 */
export function useAssistantVoice({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  const autoSpeakRef = useRef(autoSpeak);
  const startingRef = useRef(false);
  const startedRef = useRef(false);
  const finalRef = useRef(false);
  const onDeviceRef = useRef(false);
  const networkRetryRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onTranscriptRef.current = onTranscript;
  autoSpeakRef.current = autoSpeak;

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(ASSISTANT_VOICE_AUTOPLAY_KEY)
      .then((value) => {
        if (!cancelled && value === "0") setAutoSpeak(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      finalRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      ExpoSpeechRecognitionModule.abort();
      void Speech.stop();
    };
  }, []);

  useSpeechRecognitionEvent("start", () => {
    startingRef.current = false;
    startedRef.current = true;
    setListening(true);
    setStatus(null);
  });

  useSpeechRecognitionEvent("end", () => {
    startingRef.current = false;
    startedRef.current = false;
    setListening(false);
    setInterim("");
  });

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = normalizeVoiceTranscript(event.results[0]?.transcript ?? "");
    if (!transcript) return;
    if (!event.isFinal) {
      setInterim(transcript);
      return;
    }
    finalRef.current = true;
    setInterim("");
    setStatus(null);
    ExpoSpeechRecognitionModule.abort();
    onTranscriptRef.current(transcript);
  });

  useSpeechRecognitionEvent("error", (event) => {
    startingRef.current = false;
    startedRef.current = false;
    setListening(false);
    if (event.error === "aborted") return;
    if (
      onDeviceRef.current &&
      !networkRetryRef.current &&
      (event.error === "language-not-supported" ||
        event.error === "service-not-allowed" ||
        event.error === "client")
    ) {
      networkRetryRef.current = true;
      onDeviceRef.current = false;
      setStatus("Zkouším rozpoznávání přes síť…");
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        try {
          ExpoSpeechRecognitionModule.start(recognitionOptions(false));
        } catch {
          setStatus(voiceErrorMessage("unknown"));
        }
      }, 350);
      return;
    }
    if (finalRef.current) return;
    setStatus(voiceErrorMessage(event.error));
  });

  const stopSpeaking = useCallback(() => {
    setSpeakingId(null);
    void Speech.stop();
  }, []);

  const speak = useCallback((id: string, answer: string) => {
    const text = speechTextFromAnswer(answer);
    if (!text) return;
    void Speech.stop().finally(() => {
      setSpeakingId(id);
      Speech.speak(text, {
        language: ASSISTANT_VOICE_LANG,
        rate: 1,
        pitch: 1,
        onDone: () => setSpeakingId((current) => (current === id ? null : current)),
        onStopped: () => setSpeakingId((current) => (current === id ? null : current)),
        onError: () => setSpeakingId((current) => (current === id ? null : current)),
      });
    });
  }, []);

  const toggleAutoSpeak = useCallback(() => {
    const next = !autoSpeakRef.current;
    autoSpeakRef.current = next;
    setAutoSpeak(next);
    void AsyncStorage.setItem(ASSISTANT_VOICE_AUTOPLAY_KEY, next ? "1" : "0").catch(() => {});
    if (!next) {
      setSpeakingId(null);
      void Speech.stop();
    }
  }, []);

  const startListening = useCallback(async () => {
    if (startingRef.current || startedRef.current) return;
    startingRef.current = true;
    finalRef.current = false;
    networkRetryRef.current = false;
    setStatus(null);
    setInterim("");
    setSpeakingId(null);
    await Speech.stop().catch(() => {});
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        startingRef.current = false;
        setStatus("Rozpoznávání řeči na tomto zařízení není dostupné.");
        return;
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => null);
      if (!permission?.granted) {
        startingRef.current = false;
        setStatus(voiceErrorMessage("not-allowed"));
        if (permission?.canAskAgain === false) {
          Alert.alert("Chybí oprávnění", "Povol mikrofon a rozpoznávání řeči v nastavení zařízení.", [
            { text: "Zavřít", style: "cancel" },
            { text: "Otevřít nastavení", onPress: () => void Linking.openSettings() },
          ]);
        }
        return;
      }
      onDeviceRef.current = await supportsCzechOnDevice();
      ExpoSpeechRecognitionModule.start(recognitionOptions(onDeviceRef.current));
    } catch {
      startingRef.current = false;
      setStatus(voiceErrorMessage("unknown"));
    }
  }, []);

  const stopListening = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const cancelListening = useCallback(() => {
    finalRef.current = true;
    startingRef.current = false;
    ExpoSpeechRecognitionModule.abort();
    setListening(false);
    setInterim("");
    setStatus(null);
  }, []);

  const clearStatus = useCallback(() => setStatus(null), []);

  return {
    listening,
    interim,
    status,
    autoSpeak,
    speakingId,
    startListening,
    stopListening,
    cancelListening,
    clearStatus,
    toggleAutoSpeak,
    speak,
    stopSpeaking,
  };
}
