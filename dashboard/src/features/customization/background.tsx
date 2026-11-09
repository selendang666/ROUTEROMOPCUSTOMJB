import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Trash2, Upload } from "lucide-react";
import { ConfirmDialog } from "../../components/shared";
import { Button } from "../../components/ui/button";
import { isRecord } from "../../lib/helpers.js";
import { formatBytes } from "../../lib/files";

export type CustomAssetKind = "image" | "video";

export interface CustomAsset {
  kind: CustomAssetKind;
  blob: Blob;
  name: string;
}

export interface CustomizationSettings {
  backgroundAsset: CustomAsset | null;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundPreferenceVersion: number;
  glassEnabled: boolean;
  /** Glass depth: 1 = Subtle glass, 2 = Elevated glass. Only meaningful while `glassEnabled`. */
  glassDepth: 1 | 2;
}

const DEFAULT_BACKGROUND_URL = `${import.meta.env.BASE_URL}default-backgrounds.webp`;
const BACKGROUND_PREFERENCE_VERSION = 1;
const DATABASE_NAME = "ohmyomop-router-console-customization-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "settings";
const RECORD_KEY = "current";
// Keep Oh My Omop - Router isolated from other local apps that may reuse the older
// generic customization key.
const LEGACY_STORAGE_KEY = "ohmyomop-router.console.customization";
const CHANGE_EVENT = "ohmyomop-router-console-customization-change";
// Local-only storage (IndexedDB) — no network/server exposure, so the hard
// cap exists purely to keep the browser's own memory usage bounded.
export const MAX_CUSTOM_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
// Above this, warn before committing — large media can slow previews and
// use more browser memory, but nothing stops the user from keeping it.
const WARN_ASSET_BYTES = 200 * 1024 * 1024;
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);

const DEFAULTS: CustomizationSettings = {
  backgroundAsset: null,
  backgroundEnabled: false,
  backgroundOpacity: 21,
  backgroundBlur: 2,
  backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
  glassEnabled: false,
  glassDepth: 1,
};

let cachedSettings: CustomizationSettings | null = null;
let hasHydrated = false;
let saveTimer: number | undefined;
let hydrationPromise: Promise<CustomizationSettings> | null = null;

function isCustomAsset(value: unknown): value is CustomAsset {
  if (!isRecord(value) || !(value.blob instanceof Blob)) return false;
  return (value.kind === "image" || value.kind === "video") && typeof value.name === "string";
}

function normalizeGlassDepth(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1;
}

function parseStoredSettings(value: unknown): CustomizationSettings | null {
  if (!isRecord(value)) return null;
  const backgroundAsset = isCustomAsset(value.backgroundAsset) ? value.backgroundAsset : null;
  const hasCurrentPreference = value.backgroundPreferenceVersion === BACKGROUND_PREFERENCE_VERSION;
  let backgroundEnabled = DEFAULTS.backgroundEnabled;
  if (backgroundAsset !== null || hasCurrentPreference) backgroundEnabled = value.backgroundEnabled !== false;
  return {
    backgroundAsset,
    glassEnabled: typeof value.glassEnabled === "boolean" ? value.glassEnabled : DEFAULTS.glassEnabled,
    glassDepth: normalizeGlassDepth(value.glassDepth),
    backgroundEnabled,
    backgroundOpacity: typeof value.backgroundOpacity === "number" ? value.backgroundOpacity : DEFAULTS.backgroundOpacity,
    backgroundBlur: typeof value.backgroundBlur === "number" ? value.backgroundBlur : DEFAULTS.backgroundBlur,
    backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
  };
}

function openCustomizationDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  if (typeof indexedDB === "undefined") {
    reject(new Error("IndexedDB is unavailable."));
    return promise;
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open customization storage."));
  return promise;
}

async function readFromDatabase(): Promise<CustomizationSettings | null> {
  const database = await openCustomizationDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<CustomizationSettings | null>();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
  request.onsuccess = () => resolve(parseStoredSettings(request.result));
  request.onerror = () => reject(request.error ?? new Error("Could not read customization storage."));
  transaction.onerror = () => reject(transaction.error ?? new Error("Could not read customization storage."));
  transaction.onabort = () => reject(transaction.error ?? new Error("Could not read customization storage."));
  try {
    return await promise;
  } finally {
    database.close();
  }
}

async function writeToDatabase(settings: CustomizationSettings): Promise<void> {
  const database = await openCustomizationDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(settings, RECORD_KEY);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("Could not save customization storage."));
  transaction.onabort = () => reject(transaction.error ?? new Error("Could not save customization storage."));
  try {
    await promise;
  } finally {
    database.close();
  }
}

async function dataUrlToAsset(dataUrl: string, kind: CustomAssetKind, name: string): Promise<CustomAsset | null> {
  try {
    const response = await fetch(dataUrl);
    return { kind, blob: await response.blob(), name };
  } catch {
    return null;
  }
}

async function migrateLegacySettings(): Promise<CustomizationSettings> {
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return { ...DEFAULTS };

  try {
    const parsed: unknown = JSON.parse(legacy);
    if (!isRecord(parsed)) return { ...DEFAULTS };
    const backgroundAsset = typeof parsed.backgroundDataUrl === "string"
      ? await dataUrlToAsset(parsed.backgroundDataUrl, "image", "migrated-background")
      : null;
    return {
      ...DEFAULTS,
      backgroundAsset,
      backgroundEnabled: backgroundAsset !== null ? parsed.backgroundEnabled !== false : DEFAULTS.backgroundEnabled,
      backgroundOpacity: typeof parsed.backgroundOpacity === "number" ? parsed.backgroundOpacity : DEFAULTS.backgroundOpacity,
      backgroundBlur: typeof parsed.backgroundBlur === "number" ? parsed.backgroundBlur : DEFAULTS.backgroundBlur,
    };
  } catch {
    return { ...DEFAULTS };
  } finally {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

async function hydrateCustomizationSettings(): Promise<CustomizationSettings> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const stored = await readFromDatabase();
      const next = stored ?? await migrateLegacySettings();
      // Only adopt the hydrated value if we haven't already cached a newer
      // one (user may have moved a slider while the async IDB read was in
      // flight — adopting the stale DB copy would snap the slider back).
      if (!hasHydrated) {
        cachedSettings = next;
        hasHydrated = true;
        await writeToDatabase(next);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }
      return cachedSettings ?? { ...DEFAULTS };
    } catch (error) {
      console.warn("Customization persistence unavailable.", error);
      cachedSettings ??= { ...DEFAULTS };
      return cachedSettings;
    }
  })();
  return hydrationPromise;
}

export function readCustomizationSettings(): CustomizationSettings {
  if (cachedSettings) return cachedSettings;
  cachedSettings = { ...DEFAULTS };
  return cachedSettings;
}

export function saveCustomizationSettings(patch: Partial<CustomizationSettings>): CustomizationSettings {
  const next = {
    ...readCustomizationSettings(),
    ...patch,
    backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
  };
  cachedSettings = next;
  // Mark as hydrated so the async IDB read doesn't snap the slider back
  // to the stale DB value after the user already moved it.
  hasHydrated = true;
  if (typeof window === "undefined") return next;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void writeToDatabase(next).catch((error: unknown) => console.warn("Could not persist customization settings.", error));
    saveTimer = undefined;
  }, 250);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function useCustomizationSettings(): [CustomizationSettings, (patch: Partial<CustomizationSettings>) => void] {
  const [settings, setSettings] = useState<CustomizationSettings>(readCustomizationSettings);
  useEffect(() => {
    let active = true;
    void hydrateCustomizationSettings().then(() => {
      if (active) setSettings(readCustomizationSettings());
    });
    const sync = () => setSettings(readCustomizationSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      active = false;
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);
  return [settings, (patch) => setSettings(saveCustomizationSettings(patch))];
}

export function useCustomizationAssetUrl(asset: CustomAsset | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(asset.blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [asset]);
  return url;
}

export function CustomAtmosphere() {
  const [settings] = useCustomizationSettings();
  const customBackgroundUrl = useCustomizationAssetUrl(settings.backgroundAsset);
  const backgroundUrl = settings.backgroundAsset ? customBackgroundUrl : DEFAULT_BACKGROUND_URL;
  useEffect(() => {
    const root = document.documentElement;
    // Remove the retired performance-mode attribute from tabs upgraded in place.
    root.removeAttribute("data-glass");
    if (settings.glassEnabled) root.setAttribute("data-glass-enabled", "true");
    else root.removeAttribute("data-glass-enabled");
  }, [settings.glassEnabled]);
  useEffect(() => {
    document.documentElement.setAttribute("data-glass-depth", String(settings.glassDepth));
  }, [settings.glassDepth]);

  if (!backgroundUrl || !settings.backgroundEnabled) return null;

  const backgroundStyle = {
    opacity: settings.backgroundOpacity / 100,
    "--custom-bg-blur": `${settings.backgroundBlur}px`,
  } as CSSProperties;

  if (settings.backgroundAsset?.kind === "video") {
    return (
      <video
        className="custom-background-layer"
        src={backgroundUrl}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        tabIndex={-1}
        aria-hidden="true"
        style={backgroundStyle}
      />
    );
  }

  return <img className="custom-background-layer" src={backgroundUrl} alt="" aria-hidden="true" draggable={false} style={backgroundStyle} />;
}

export function classifyCustomAssetFile(file: Pick<File, "name" | "type">): CustomAssetKind | null {
  const mediaType = file.type.toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  const extension = file.name.toLowerCase().split(".").pop();
  return extension !== undefined && VIDEO_FILE_EXTENSIONS.has(extension) ? "video" : null;
}

export function BackgroundUpload({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useCustomizationSettings();
  const [pendingLargeFile, setPendingLargeFile] = useState<{ file: File; kind: CustomAssetKind } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitFile = (file: File, kind: CustomAssetKind) => {
    setSettings({
      backgroundAsset: { kind, blob: file, name: file.name },
      backgroundEnabled: true,
    });
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const kind = classifyCustomAssetFile(file);
    if (kind === null) {
      onError("Choose an image or video file (MP4, WebM, OGV, or MOV).");
      return;
    }
    if (file.size > MAX_CUSTOM_ASSET_BYTES) {
      onError(`Media exceeds the ${formatBytes(MAX_CUSTOM_ASSET_BYTES)} limit.`);
      return;
    }
    if (file.size > WARN_ASSET_BYTES) {
      setPendingLargeFile({ file, kind });
      return;
    }
    commitFile(file, kind);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
          <Upload size={14} aria-hidden="true" />
          {settings.backgroundAsset ? "Change file" : "Choose image or video"}
        </Button>
        {settings.backgroundAsset ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setSettings({ backgroundAsset: null })}>
            <Trash2 size={14} aria-hidden="true" /> Delete
          </Button>
        ) : null}
        <span className="text-[11px] text-[var(--text-3)]">Images &amp; video: MP4, WebM, OGV, MOV — up to {formatBytes(MAX_CUSTOM_ASSET_BYTES)}</span>
        <input ref={inputRef} type="file" accept="image/*,video/*,.mp4,.webm,.ogv,.mov" className="sr-only" onChange={handleFile} />
      </div>
      <ConfirmDialog
        open={pendingLargeFile !== null}
        onClose={() => setPendingLargeFile(null)}
        onConfirm={() => {
          if (pendingLargeFile) commitFile(pendingLargeFile.file, pendingLargeFile.kind);
        }}
        title="Large media file"
        message={
          pendingLargeFile
            ? `Your media is ${formatBytes(pendingLargeFile.file.size)} — files this large can use more browser memory and slow down previews. It stays local to this browser either way.`
            : ""
        }
        confirmLabel="Keep"
        cancelLabel="Revert"
      />
    </div>
  );
}
