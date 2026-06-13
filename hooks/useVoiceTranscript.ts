"use client";

/**
 * useVoiceTranscript — Wave C voice-teach hook.
 *
 * Why: Wave C lets AMs teach the Keeper a fact by SPEAKING — Keeper-mic on
 * V2BrainPanel and Beam-mic in AskPanel both ride on this hook to turn voice
 * into text. Browser-native Web Speech API (window.SpeechRecognition /
 * window.webkitSpeechRecognition) keeps the spend at $0/mo: nothing is sent
 * to a transcription vendor. Haiku is the only paid stage downstream.
 *
 * Behavior contract:
 *   - supported: false on browsers without SpeechRecognition (Firefox today).
 *   - isListening: true between start() and a final / error / manual stop().
 *   - transcript: accumulated final-result text. Interim chunks are merged
 *     into transcript only when they finalize; mid-utterance partials are
 *     surfaced via the same string so the UI can show "live" text without
 *     a second state slot.
 *   - error: typed enum string ("unsupported" | "permission_denied" |
 *     "no_speech" | "audio_capture" | "network" | "unknown"). UI maps the
 *     enum to friendly copy, the hook stays headless.
 *   - start() — begins listening. Soft no-op when already listening.
 *   - stop() — graceful stop; the last recognized chunk still flushes into
 *     transcript via the onresult event before onend.
 *   - reset() — clears transcript + error. Caller invokes between teach
 *     sessions so the next utterance starts clean.
 *
 * Reduced-motion: the hook itself doesn't animate — pulse/glow concerns
 * live in the consuming UI (KeeperMicButton, BeamMicButton). Hook just
 * exposes booleans, the UI honors prefers-reduced-motion.
 *
 * Safari quirk: webkitSpeechRecognition is the only available constructor;
 * we feature-detect both names. continuous=false is intentional — we want
 * one utterance per teach attempt; the AM clicks again to record more.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceTranscriptError =
  | "unsupported"
  | "permission_denied"
  | "no_speech"
  | "audio_capture"
  | "network"
  | "unknown";

export interface UseVoiceTranscriptResult {
  supported: boolean;
  isListening: boolean;
  transcript: string;
  error: VoiceTranscriptError | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

/**
 * Minimal subset of the SpeechRecognition browser API surface we touch.
 * Keeps the hook strict-mode TS clean without pulling a global d.ts.
 */
interface SpeechRecognitionLikeEvent {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionLikeEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function mapErrorCode(raw: string): VoiceTranscriptError {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission_denied";
    case "no-speech":
      return "no_speech";
    case "audio-capture":
      return "audio_capture";
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

export function useVoiceTranscript(): UseVoiceTranscriptResult {
  const [supported, setSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<VoiceTranscriptError | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // The accumulator captures finalized chunks; interim text rides on top
  // and is replaced on every keystroke-of-speech without polluting state.
  const finalAccumRef = useRef("");

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    setSupported(!!Ctor);
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("unsupported");
      return;
    }
    // Already listening — soft no-op so double-clicks don't tear down state.
    if (recRef.current) return;

    let rec: SpeechRecognitionLike;
    try {
      rec = new Ctor();
    } catch {
      setError("unknown");
      return;
    }
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      finalAccumRef.current = "";
      setTranscript("");
      setError(null);
      setIsListening(true);
    };

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const chunk = res[0]?.transcript ?? "";
        if (res.isFinal) {
          finalAccumRef.current = (finalAccumRef.current + " " + chunk).trim();
        } else {
          interim += chunk;
        }
      }
      const combined = (finalAccumRef.current + " " + interim).trim();
      setTranscript(combined);
    };

    rec.onerror = (event) => {
      setError(mapErrorCode(event.error));
    };

    rec.onend = () => {
      setIsListening(false);
      recRef.current = null;
    };

    try {
      rec.start();
      recRef.current = rec;
    } catch {
      // start() throws if a previous recognition is still wrapping up.
      setError("unknown");
      recRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // Browsers occasionally throw if onend already fired — ignore.
    }
  }, []);

  const reset = useCallback(() => {
    finalAccumRef.current = "";
    setTranscript("");
    setError(null);
  }, []);

  // Defensive cleanup if the component unmounts mid-utterance.
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // ignore
        }
        recRef.current = null;
      }
    };
  }, []);

  return { supported, isListening, transcript, error, start, stop, reset };
}

export default useVoiceTranscript;
