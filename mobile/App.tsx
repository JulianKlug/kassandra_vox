/**
 * Vox - Privacy-preserving medical dictation.
 *
 * MVP first screen: model download (if needed), then a record button +
 * live transcript view. Everything stays on-device.
 *
 * Design tokens come from /Users/jk/temp/vox/DESIGN.md.
 */

import React, { useEffect, useState, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  Platform,
  PermissionsAndroid,
} from "react-native";
import {
  isModelDownloaded,
  downloadModel,
  ensureModelsDir,
  getModelInfo,
  hasResumableDownload,
  clearPartialDownload,
  ModelVariant,
  DownloadProgress,
} from "./src/whisper/model";
import {
  loadModel,
  isModelLoaded,
  startRealtimeTranscription,
  RealtimeHandle,
} from "./src/whisper/transcriber";
import { applyCorrections } from "./src/pipeline/correct";

// Design tokens (from DESIGN.md)
const COLORS = {
  primary: "#0a7e8c",
  recording: "#ff3b30",
  success: "#34c759",
  text: "#1a1a1a",
  secondary: "#636366",
  muted: "#8e8e93",
  bg: "#fafafa",
  surface: "#ffffff",
  border: "#e5e5e5",
  correction: "#fff3cd",
};

type AppState =
  | "checking"
  | "needsDownload"
  | "downloading"
  | "loadingModel"
  | "ready"
  | "recording"
  | "transcribing";

const MODEL_VARIANT: ModelVariant = "medium";

export default function App() {
  const [state, setState] = useState<AppState>("checking");
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);
  const [resumable, setResumable] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const realtimeRef = useRef<RealtimeHandle | null>(null);
  const transcriptBaseRef = useRef("");

  // Initial: check whether model exists, request mic permission
  useEffect(() => {
    (async () => {
      try {
        await ensureModelsDir();
        const has = await isModelDownloaded(MODEL_VARIANT);
        if (!has) {
          // Check if we have a partial download we can resume
          const canResume = await hasResumableDownload(MODEL_VARIANT);
          setResumable(canResume);
          setState("needsDownload");
        } else {
          await loadAndReady();
        }
        // Request mic permission early on Android
        await requestMicPermission();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  async function requestMicPermission(): Promise<boolean> {
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: "Microphone",
          message: "Vox a besoin du microphone pour la dictee.",
          buttonPositive: "OK",
        }
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    // iOS permission is handled via Info.plist + the system prompt at first use
    return true;
  }

  async function loadAndReady() {
    setState("loadingModel");
    try {
      await loadModel(MODEL_VARIANT);
      setState("ready");
    } catch (e: any) {
      setError(`Model load failed: ${e?.message ?? e}`);
    }
  }

  async function handleDownload() {
    setState("downloading");
    setError(null);
    try {
      await downloadModel(MODEL_VARIANT, (p: DownloadProgress) => {
        setDownloadPercent(p.percent);
        setDownloadBytes(p.bytesWritten);
        setDownloadTotal(p.totalBytes);
      });
      setResumable(false);
      await loadAndReady();
    } catch (e: any) {
      // Check if we now have something to resume from
      const canResume = await hasResumableDownload(MODEL_VARIANT);
      setResumable(canResume);
      setError(`Telechargement interrompu: ${e?.message ?? e}`);
      setState("needsDownload");
    }
  }

  async function handleStartOver() {
    try {
      await clearPartialDownload(MODEL_VARIANT);
      setResumable(false);
      setDownloadPercent(0);
      setDownloadBytes(0);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function handleStartRecording() {
    if (!isModelLoaded()) {
      setError("Model not loaded");
      return;
    }
    try {
      const granted = await requestMicPermission();
      if (!granted) {
        setError("Permission microphone refusee");
        return;
      }

      // Snapshot the existing transcript so streaming updates only replace
      // the current dictation segment, not the whole history.
      transcriptBaseRef.current = transcript;
      setLatencyMs(null);

      const handle = await startRealtimeTranscription(
        (update) => {
          // Apply medical post-processor to each incremental update so the
          // user sees corrected text in real time, not raw whisper output.
          const corrected = applyCorrections(update.text);
          const base = transcriptBaseRef.current;
          const composed = base
            ? `${base} ${corrected.text.trim()}`
            : corrected.text.trim();
          setTranscript(composed);
          setLatencyMs(update.processTimeMs);

          if (update.isFinal) {
            setState("ready");
            realtimeRef.current = null;
          }
        },
        (errMsg) => {
          setError(`Transcription: ${errMsg}`);
          setState("ready");
          realtimeRef.current = null;
        }
      );
      realtimeRef.current = handle;
      setState("recording");
    } catch (e: any) {
      setError(`Enregistrement: ${e?.message ?? e}`);
      setState("ready");
    }
  }

  async function handleStopRecording() {
    const handle = realtimeRef.current;
    if (!handle) return;
    try {
      setState("transcribing");
      await handle.stop();
      // The final result will arrive via the onUpdate callback with
      // isFinal=true, which transitions us back to "ready".
    } catch (e: any) {
      setError(`Arret: ${e?.message ?? e}`);
      setState("ready");
      realtimeRef.current = null;
    }
  }

  // ----- Render helpers -----

  function renderDownload() {
    const info = getModelInfo(MODEL_VARIANT);
    const downloadingNow = state === "downloading";
    const buttonLabel = resumable ? "Reprendre" : "Telecharger";

    return (
      <View style={styles.centerContainer}>
        <Text style={styles.brandTitle}>Vox</Text>
        <Text style={styles.brandSubtitle}>Dictee medicale privee</Text>

        <View style={{ height: 48 }} />

        <Text style={styles.downloadHeader}>Telechargement du modele vocal</Text>
        <Text style={styles.downloadSize}>{info.sizeLabel}</Text>

        <View style={{ height: 24 }} />

        <Text style={styles.privacyMessage}>
          Ce modele d'intelligence artificielle reste sur votre appareil.
          Vos dictees ne quitteront jamais votre telephone.
        </Text>

        <View style={{ height: 16 }} />

        <Text style={styles.privacyHint}>
          Gardez l'application ouverte pendant le telechargement.
        </Text>

        <View style={{ height: 32 }} />

        {downloadingNow ? (
          <View style={{ alignItems: "center" }}>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(downloadPercent * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {Math.round(downloadPercent * 100)}% &middot; {formatBytes(downloadBytes)}
              {downloadTotal > 0 ? ` / ${formatBytes(downloadTotal)}` : ""}
            </Text>
          </View>
        ) : (
          <View style={{ alignItems: "center" }}>
            {resumable && (
              <Text style={styles.resumeNote}>
                Telechargement partiel detecte. Reprendre la ou il s'est arrete.
              </Text>
            )}
            <TouchableOpacity style={styles.primaryButton} onPress={handleDownload}>
              <Text style={styles.primaryButtonText}>{buttonLabel}</Text>
            </TouchableOpacity>
            {resumable && (
              <TouchableOpacity onPress={handleStartOver} style={{ marginTop: 16 }}>
                <Text style={styles.secondaryAction}>Recommencer depuis zero</Text>
              </TouchableOpacity>
            )}
            {error && <Text style={styles.inlineError}>{error}</Text>}
          </View>
        )}
      </View>
    );
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mo`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
  }

  function renderLoading(label: string) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.brandTitle}>Vox</Text>
        <Text style={styles.loadingLabel}>{label}</Text>
      </View>
    );
  }

  function renderDictation() {
    const isRecording = state === "recording";
    const isBusy = state === "transcribing";

    return (
      <View style={styles.dictationContainer}>
        <View style={styles.topBar}>
          <Text style={styles.appTitle}>Vox</Text>
          <View style={styles.statusRight}>
            <View style={[styles.dot, { backgroundColor: COLORS.muted }]} />
            <Text style={styles.statusLabel}>Local</Text>
          </View>
        </View>

        <ScrollView
          style={styles.transcriptArea}
          contentContainerStyle={styles.transcriptContent}
        >
          {transcript ? (
            <Text style={styles.transcriptText}>{transcript}</Text>
          ) : (
            <Text style={styles.placeholder}>
              Appuyez sur le bouton pour commencer la dictee.
            </Text>
          )}
          {latencyMs !== null && (
            <Text style={styles.latency}>
              Derniere transcription: {(latencyMs / 1000).toFixed(1)}s
            </Text>
          )}
        </ScrollView>

        <View style={styles.controls}>
          <TouchableOpacity
            style={[
              styles.recordButton,
              isRecording && styles.recordButtonRecording,
              isBusy && styles.recordButtonDisabled,
            ]}
            onPress={isRecording ? handleStopRecording : handleStartRecording}
            disabled={isBusy}
          >
            <View
              style={[
                styles.recordButtonInner,
                isRecording && styles.recordButtonInnerRecording,
              ]}
            />
          </TouchableOpacity>
          <Text style={styles.controlLabel}>
            {isBusy
              ? "Transcription..."
              : isRecording
              ? "Toucher pour arreter"
              : "Toucher pour dicter"}
          </Text>
        </View>
      </View>
    );
  }

  // ----- Main render -----

  let content: React.ReactNode;
  // For download errors we keep the user on the download screen so they
  // can resume; only show the full-screen error for other failures.
  const isDownloadError = error && state === "needsDownload";

  if (error && !isDownloadError) {
    content = (
      <View style={styles.centerContainer}>
        <Text style={styles.errorTitle}>Erreur</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => {
            setError(null);
            setState("checking");
          }}
        >
          <Text style={styles.primaryButtonText}>Reessayer</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (state === "checking") {
    content = renderLoading("Initialisation...");
  } else if (state === "needsDownload" || state === "downloading") {
    content = renderDownload();
  } else if (state === "loadingModel") {
    content = renderLoading("Chargement du modele...");
  } else {
    content = renderDictation();
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingTop: Platform.OS === "ios" ? 54 : 24,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  brandTitle: {
    fontSize: 32,
    fontWeight: "700",
    color: COLORS.text,
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 8,
  },
  downloadHeader: {
    fontSize: 16,
    color: COLORS.text,
    fontWeight: "600",
  },
  downloadSize: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 4,
  },
  privacyMessage: {
    fontSize: 14,
    color: COLORS.secondary,
    textAlign: "center",
    lineHeight: 22,
  },
  privacyHint: {
    fontSize: 12,
    color: COLORS.muted,
    textAlign: "center",
    fontStyle: "italic",
  },
  resumeNote: {
    fontSize: 13,
    color: COLORS.secondary,
    textAlign: "center",
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  secondaryAction: {
    fontSize: 13,
    color: COLORS.muted,
    textDecorationLine: "underline",
  },
  inlineError: {
    fontSize: 12,
    color: COLORS.recording,
    textAlign: "center",
    marginTop: 16,
    paddingHorizontal: 16,
  },
  progressBar: {
    width: 240,
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: COLORS.primary,
  },
  progressText: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 12,
    fontVariant: ["tabular-nums"],
  },
  primaryButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 6,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingLabel: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 16,
  },
  dictationContainer: {
    flex: 1,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  appTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
    letterSpacing: -0.3,
  },
  statusRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 11,
    color: COLORS.muted,
  },
  transcriptArea: {
    flex: 1,
  },
  transcriptContent: {
    padding: 20,
    paddingBottom: 32,
  },
  transcriptText: {
    fontSize: 16,
    lineHeight: 26,
    color: COLORS.text,
  },
  placeholder: {
    fontSize: 15,
    color: COLORS.muted,
    fontStyle: "italic",
  },
  latency: {
    fontSize: 11,
    color: COLORS.muted,
    marginTop: 16,
    fontVariant: ["tabular-nums"],
  },
  controls: {
    paddingBottom: 48,
    paddingTop: 16,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  recordButtonRecording: {
    backgroundColor: COLORS.recording,
  },
  recordButtonDisabled: {
    opacity: 0.5,
  },
  // Idle: solid circle (the universal "record" symbol).
  recordButtonInner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#fff",
  },
  // Recording: solid square (the universal "stop" symbol).
  recordButtonInnerRecording: {
    width: 24,
    height: 24,
    borderRadius: 4,
  },
  controlLabel: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.recording,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 14,
    color: COLORS.text,
    textAlign: "center",
    marginBottom: 24,
  },
});
