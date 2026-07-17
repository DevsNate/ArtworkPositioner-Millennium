import {
  callable,
  DialogButton,
  EUIMode,
  findSP,
  IconsModule,
  Millennium,
  Navigation,
  PanelSection,
  PanelSectionRow,
  routerHook,
  showModal,
  SliderField,
  toaster,
  useParams,
} from '@steambrew/client';
import { useEffect, useMemo, useState } from 'react';
import { subscribeToDocument } from './window-runtime';

declare const SteamClient: {
  UI: {
    GetUIMode(): Promise<EUIMode>;
  };
};

type HeroOffsets = Record<string, number>;
type HeroMode = 'bigpicture' | 'desktop';
type HeroAxis = 'horizontal' | 'vertical';
type SetHeroOffsetsParams = { offsets_json: string };

const STORAGE_KEY = 'artwork-positioner:hero:offsets:v1';
const LAST_APPID_STORAGE_KEY = 'artwork-positioner:hero:lastAppId:v1';
const LEGACY_STORAGE_KEY = 'hero-position:offsets:v1';
const LEGACY_LAST_APPID_STORAGE_KEY = 'hero-position:lastAppId:v1';
const OFFSET_MIN = -600;
const OFFSET_MAX = 600;
const OFFSET_STEP = 1;
const DEFAULT_OFFSET = 0;
const SAVE_DEBOUNCE_MS = 200;
const RUNTIME_WATCHDOG_MS = 1000;
const RUNTIME_STYLE_ID = 'hero-position-runtime-style';
const DESKTOP_APPLIED_ATTRIBUTE = 'data-hero-position-desktop-applied';
const DESKTOP_ORIGINAL_VALUE_ATTRIBUTE = 'data-hero-position-original-object-position';
const DESKTOP_ORIGINAL_PRIORITY_ATTRIBUTE = 'data-hero-position-original-object-position-priority';
const MENU_ITEM_CLASS = 'hero-position-menu-item';
const MENU_ITEM_TEXT = 'Adjust Hero Position...';
const setHeroOffsets = callable<[SetHeroOffsetsParams], string | false>('set_hero_offsets');
const getHeroOffsets = callable<[], string | false>('get_hero_offsets');

const isGamepadUIMode = (mode: EUIMode) => mode === EUIMode.GamePad || Number(mode) === 4;

const clampOffset = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_OFFSET;
  }
  return Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(parsed)));
};

const normalizeAppIdText = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }

  const appid = Number.parseInt(text, 10);
  return Number.isFinite(appid) && appid > 0 ? String(appid) : null;
};

const rememberLastAppId = (appid: number | string) => {
  const normalized = normalizeAppIdText(appid);
  if (normalized) {
    window.localStorage.setItem(LAST_APPID_STORAGE_KEY, normalized);
  }
};

const offsetKeyForMode = (appid: string, mode: HeroMode, axis: HeroAxis = 'horizontal') => {
  if (axis === 'vertical') {
    return mode === 'desktop' ? `desktop-vertical:${appid}` : `vertical:${appid}`;
  }
  return mode === 'desktop' ? `desktop:${appid}` : appid;
};

const parseOffsetKey = (key: string): { appid: string; mode: HeroMode; axis: HeroAxis } | null => {
  const desktopVerticalAppId = normalizeAppIdText(key.match(/^desktop-vertical:(\d+)$/)?.[1]);
  if (desktopVerticalAppId) {
    return { appid: desktopVerticalAppId, mode: 'desktop', axis: 'vertical' };
  }

  const bigPictureVerticalAppId = normalizeAppIdText(key.match(/^vertical:(\d+)$/)?.[1]);
  if (bigPictureVerticalAppId) {
    return { appid: bigPictureVerticalAppId, mode: 'bigpicture', axis: 'vertical' };
  }

  const desktopAppId = normalizeAppIdText(key.match(/^desktop:(\d+)$/)?.[1]);
  if (desktopAppId) {
    return { appid: desktopAppId, mode: 'desktop', axis: 'horizontal' };
  }

  const bigPictureAppId = normalizeAppIdText(key);
  return bigPictureAppId ? { appid: bigPictureAppId, mode: 'bigpicture', axis: 'horizontal' } : null;
};

const offsetForMode = (offsets: HeroOffsets, appid: string, mode: HeroMode, axis: HeroAxis) =>
  offsets[offsetKeyForMode(appid, mode, axis)] ?? DEFAULT_OFFSET;

const normalizeOffsets = (value: unknown): HeroOffsets => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<HeroOffsets>((current, [key, rawOffset]) => {
    const parsedKey = parseOffsetKey(key);
    const offset = clampOffset(rawOffset);
    if (parsedKey && offset !== DEFAULT_OFFSET) {
      current[offsetKeyForMode(parsedKey.appid, parsedKey.mode, parsedKey.axis)] = offset;
    }
    return current;
  }, {});
};

const readOffsets = (): HeroOffsets => {
  try {
    return normalizeOffsets(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return {};
  }
};

const writeOffsets = (offsets: HeroOffsets) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offsets));
  applyAllHeroPositionStyles(offsets);
  window.dispatchEvent(new CustomEvent('hero-position:offsets-changed'));
};

type BackendResult = { ok: boolean; error?: string };

const requireSuccessfulBackendResult = (response: string | false) => {
  if (response === false) {
    throw new Error('backend_unavailable');
  }

  const parsed = JSON.parse(response) as BackendResult;
  if (!parsed?.ok) {
    throw new Error(parsed?.error || 'save_failed');
  }
};

const saveOffsetsToDisk = async (_appid: string, _offset: number, offsets: HeroOffsets) => {
  requireSuccessfulBackendResult(await setHeroOffsets({ offsets_json: JSON.stringify(offsets) }));
};

let pendingSave: { appid: string; offset: number; offsets: HeroOffsets; onError: () => void } | null = null;
let saveTimer: number | undefined;
let saveChain: Promise<void> = Promise.resolve();

const scheduleOffsetsSave = (appid: string, offset: number, offsets: HeroOffsets, onError: () => void) => {
  pendingSave = { appid, offset, offsets: { ...offsets }, onError };
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }

  saveTimer = window.setTimeout(() => {
    const job = pendingSave;
    pendingSave = null;
    saveTimer = undefined;
    if (!job) {
      return;
    }

    saveChain = saveChain
      .catch((): void => undefined)
      .then(() => saveOffsetsToDisk(job.appid, job.offset, job.offsets))
      .catch(() => job.onError());
  }, SAVE_DEBOUNCE_MS);
};

const mergeBackendOffsets = async () => {
  try {
    const response = await getHeroOffsets();
    if (!response || typeof response !== 'string') {
      return readOffsets();
    }

    const backendOffsets = normalizeOffsets(JSON.parse(response));
    const merged = normalizeOffsets({ ...backendOffsets, ...readOffsets() });
    writeOffsets(merged);
    if (JSON.stringify(merged) !== JSON.stringify(backendOffsets)) {
      void saveOffsetsToDisk('', DEFAULT_OFFSET, merged).catch((): void => undefined);
    }
    return merged;
  } catch {
    return readOffsets();
  }
};

const heroImageSelectorsForApp = (appid: string) => [
  `img[src*="/customimages/${appid}_hero."]`,
  `img[src*="/${appid}_hero."]`,
  `img[src*="/${appid}_library_hero"]`,
  `img[src*="/librarycache/${appid}/hero"]`,
  `img[src*="/librarycache/${appid}/library_hero"]`,
  `img[src*="/apps/${appid}/library_hero"]`,
  `img[src*="/assets/${appid}/"][src*="/library_hero"]`,
];

const buildHeroPositionCss = (offsets: HeroOffsets, mode: HeroMode) => {
  const appids = new Set<string>();
  Object.keys(offsets).forEach((key) => {
    const parsedKey = parseOffsetKey(key);
    if (parsedKey?.mode === mode) appids.add(parsedKey.appid);
  });

  const positionValue = (offset: number) => {
    const direction = offset < 0 ? '-' : '+';
    return `calc(50% ${direction} ${Math.abs(offset)}px)`;
  };
  const rules = Array.from(appids).map((appid) => {
    const horizontal = clampOffset(offsetForMode(offsets, appid, mode, 'horizontal'));
    const vertical = clampOffset(offsetForMode(offsets, appid, mode, 'vertical'));
    if (horizontal === DEFAULT_OFFSET && vertical === DEFAULT_OFFSET) return '';
    return `${heroImageSelectorsForApp(appid).join(',\n')} {
  object-position: ${positionValue(horizontal)} ${positionValue(vertical)} !important;
}`;
  }).filter(Boolean);

  return `/* Generated by Hero Position for ${mode === 'desktop' ? 'Desktop' : 'Big Picture'}. */\n${rules.join('\n')}\n`;
};

const restoreDesktopHeroImage = (image: HTMLImageElement) => {
  const originalValue = image.getAttribute(DESKTOP_ORIGINAL_VALUE_ATTRIBUTE) ?? '';
  const originalPriority = image.getAttribute(DESKTOP_ORIGINAL_PRIORITY_ATTRIBUTE) ?? '';
  image.style.removeProperty('object-position');
  if (originalValue) {
    image.style.setProperty('object-position', originalValue, originalPriority);
  }
  image.removeAttribute(DESKTOP_APPLIED_ATTRIBUTE);
  image.removeAttribute(DESKTOP_ORIGINAL_VALUE_ATTRIBUTE);
  image.removeAttribute(DESKTOP_ORIGINAL_PRIORITY_ATTRIBUTE);
};

const applyDesktopHeroOffsets = (offsets: HeroOffsets, targetDocument: Document) => {
  const activeImages = new Set<HTMLImageElement>();
  const appids = new Set<string>();
  for (const key of Object.keys(offsets)) {
    const parsedKey = parseOffsetKey(key);
    if (parsedKey?.mode === 'desktop') appids.add(parsedKey.appid);
  }

  for (const appid of appids) {
    const horizontal = clampOffset(offsetForMode(offsets, appid, 'desktop', 'horizontal'));
    const vertical = clampOffset(offsetForMode(offsets, appid, 'desktop', 'vertical'));
    if (horizontal === DEFAULT_OFFSET && vertical === DEFAULT_OFFSET) continue;

    for (const image of targetDocument.querySelectorAll<HTMLImageElement>(heroImageSelectorsForApp(appid).join(','))) {
      activeImages.add(image);
      if (!image.hasAttribute(DESKTOP_APPLIED_ATTRIBUTE)) {
        image.setAttribute(DESKTOP_ORIGINAL_VALUE_ATTRIBUTE, image.style.getPropertyValue('object-position'));
        image.setAttribute(DESKTOP_ORIGINAL_PRIORITY_ATTRIBUTE, image.style.getPropertyPriority('object-position'));
        image.setAttribute(DESKTOP_APPLIED_ATTRIBUTE, 'true');
      }
      const horizontalDirection = horizontal < 0 ? '-' : '+';
      const verticalDirection = vertical < 0 ? '-' : '+';
      image.style.setProperty(
        'object-position',
        `calc(50% ${horizontalDirection} ${Math.abs(horizontal)}px) calc(50% ${verticalDirection} ${Math.abs(vertical)}px)`,
        'important',
      );
    }
  }

  for (const image of targetDocument.querySelectorAll<HTMLImageElement>(`[${DESKTOP_APPLIED_ATTRIBUTE}]`)) {
    if (!activeImages.has(image)) {
      restoreDesktopHeroImage(image);
    }
  }
};

const injectedStyleDocuments = new Set<Document>();
let hookedBigPictureDocument: Document | null = null;
let hookedDesktopDocument: Document | null = null;

const liveHookedDocument = (targetDocument: Document | null) =>
  targetDocument?.defaultView && !targetDocument.defaultView.closed ? targetDocument : null;

const popupDocumentForMode = (mode: HeroMode): Document | null => {
  try {
    const popups = Array.from((globalThis as any).g_PopupManager?.GetPopups?.() ?? []) as any[];
    const prefix = mode === 'desktop' ? 'SP Desktop_' : 'SP BPM_';
    return popups.find((popup) => String(popup?.m_strName ?? '').startsWith(prefix))?.m_popup?.document ?? null;
  } catch {
    return null;
  }
};

const getBigPictureDocument = (): Document | null => {
  const hooked = liveHookedDocument(hookedBigPictureDocument);
  if (hooked) {
    return hooked;
  }

  const popupDocument = popupDocumentForMode('bigpicture');
  if (popupDocument) {
    hookedBigPictureDocument = popupDocument;
    return popupDocument;
  }

  try {
    const candidate = findSP()?.document ?? null;
    return candidate?.title === 'Steam Big Picture Mode' ? candidate : null;
  } catch {
    return null;
  }
};

const getDesktopDocument = (): Document | null => {
  const hooked = liveHookedDocument(hookedDesktopDocument);
  if (hooked) {
    return hooked;
  }

  const popupDocument = popupDocumentForMode('desktop');
  if (popupDocument) {
    hookedDesktopDocument = popupDocument;
    return popupDocument;
  }
  return null;
};

const applyHeroPositionStyles = (offsets: HeroOffsets, targetDocument: Document | null, mode: HeroMode) => {
  if (!targetDocument?.head) {
    return false;
  }

  if (mode === 'desktop') {
    targetDocument.getElementById(RUNTIME_STYLE_ID)?.remove();
    applyDesktopHeroOffsets(offsets, targetDocument);
    injectedStyleDocuments.add(targetDocument);
    return true;
  }

  let style = targetDocument.getElementById(RUNTIME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = targetDocument.createElement('style');
    style.id = RUNTIME_STYLE_ID;
    style.setAttribute('data-plugin', 'artwork-positioner');
    targetDocument.head.appendChild(style);
  }

  style.textContent = buildHeroPositionCss(offsets, mode);
  style.dataset.heroPositionMode = mode;
  injectedStyleDocuments.add(targetDocument);
  return true;
};

const applyAllHeroPositionStyles = (offsets = readOffsets()) => {
  applyHeroPositionStyles(offsets, getBigPictureDocument(), 'bigpicture');
  applyHeroPositionStyles(offsets, getDesktopDocument(), 'desktop');
};

const appIdFromRouteText = (value: unknown) => {
  const route = String(value ?? '');
  return normalizeAppIdText(route.match(/\/(?:routes\/)?library\/app\/(\d+)/)?.[1])
    ?? normalizeAppIdText(route.match(/\/games\/details\/(\d+)/)?.[1]);
};

const appIdFromSteamHistory = (): string | null => {
  try {
    const entries = (history.state as { memoryhistory?: { initialEntries?: unknown[] } } | null)?.memoryhistory?.initialEntries;
    if (!Array.isArray(entries)) {
      return null;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const appid = normalizeAppIdText(String(entries[index] ?? '').match(/\/library\/app\/(\d+)/)?.[1]);
      if (appid) {
        return appid;
      }
    }
  } catch {
    return null;
  }

  return null;
};

const appIdFromCurrentLocation = (): string | null => {
  try {
    return normalizeAppIdText(window.location.pathname.match(/\/hero-position\/(\d+)/)?.[1])
      ?? appIdFromRouteText(window.location.pathname);
  } catch {
    return null;
  }
};

const appIdFromSharedSteamState = (): string | null => {
  try {
    const manager = (globalThis as any).MainWindowBrowserManager;
    return appIdFromRouteText(manager?.m_lastLocation?.pathname)
      ?? appIdFromRouteText(manager?.m_URLRequested)
      ?? appIdFromRouteText(manager?.m_URL)
      ?? normalizeAppIdText((globalThis as any).uiStore?.currentGameListSelection?.nAppId);
  } catch {
    return null;
  }
};

const fallbackAppIdText = () =>
  appIdFromCurrentLocation()
  ?? appIdFromSharedSteamState()
  ?? appIdFromSteamHistory()
  ?? normalizeAppIdText(window.localStorage.getItem(LAST_APPID_STORAGE_KEY));

const settingsStyles = `
/* Match SteamGridDB's native Millennium settings-page layout. */
.heroSettingsPage {
  width: auto;
  margin: 8px 0 28px;
  padding: 0;
  color: inherit;
}

.heroSettingsPage > *:not(style) {
  width: auto !important;
  margin-right: 0 !important;
  margin-left: 0 !important;
  padding-right: 0 !important;
  padding-left: 0 !important;
  box-sizing: border-box;
}

.heroCurrentGameRow {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.heroNativeSlider {
  width: 100% !important;
  min-height: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  border: 0 !important;
}

.heroQamSliderField {
  width: 100%;
  min-width: 0;
}

.heroQamSliderHeader {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 2px;
}

.heroQamSliderLabel {
  color: rgba(255, 255, 255, 0.86);
  font-size: 20px;
  font-weight: 400;
}

.heroQamSliderValue {
  display: flex;
  width: 116px;
  height: 48px;
  padding: 0 14px;
  border: 0;
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.58);
  background: #252a34;
  font-size: 21px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
}

.heroQamSliderValue input {
  width: auto;
  min-width: 1ch;
  max-width: 5ch;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: center;
  field-sizing: content;
  outline: 0;
}

.heroQamSliderValue input::-webkit-inner-spin-button,
.heroQamSliderValue input::-webkit-outer-spin-button {
  margin: 0;
  appearance: none;
}

.heroQamSliderTrack {
  position: relative;
  width: 100%;
  height: 54px;
}

.heroQamSliderMarker {
  position: absolute;
  top: 2px;
  left: var(--hero-slider-progress);
  z-index: 2;
  width: 0;
  height: 0;
  border-right: 10px solid transparent;
  border-left: 10px solid transparent;
  border-top: 10px solid #8b929b;
  transform: translateX(-50%);
  pointer-events: none;
}

.heroQamSliderInput {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 54px;
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
  outline: 0;
}

.heroQamSliderInput::-webkit-slider-runnable-track {
  height: 8px;
  border: 0;
  border-radius: 4px;
  background: #3b424a;
}

.heroQamSliderInput::-webkit-slider-thumb {
  width: 24px;
  height: 24px;
  margin-top: -8px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  appearance: none;
  -webkit-appearance: none;
}

.heroQamSliderInput:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px #1a9fff;
}

.heroQamSliderDescription {
  margin-top: 0;
  color: rgba(255, 255, 255, 0.76);
  font-size: 16px;
  line-height: 1.35;
}

.heroNativeActions {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  box-sizing: border-box;
}

.heroNativeActions button {
  width: 100% !important;
  min-width: 0;
}

.heroNativeActions .heroCenterButton {
  grid-column: 1 / -1;
}

@media (max-width: 410px) {
  .heroNativeActions {
    grid-template-columns: minmax(0, 1fr);
  }

  .heroNativeActions .heroCenterButton {
    grid-column: auto;
  }
}
`;

const HeroOffsetControl = ({
  label,
  axis,
  offset,
  isGamepadUI,
  onChange,
  onReset,
}: {
  label: string;
  axis: HeroAxis;
  offset: number;
  isGamepadUI: boolean;
  onChange: (offset: number) => void;
  onReset: () => void;
}) => {
  const sliderProgress = ((offset - OFFSET_MIN) / (OFFSET_MAX - OFFSET_MIN)) * 100;
  const axisLabel = axis === 'horizontal' ? 'Horizontal' : 'Vertical';
  const description = axis === 'horizontal'
    ? `Move the ${label.toLowerCase()} hero from 600 px left to 600 px right.`
    : `Move the ${label.toLowerCase()} hero from 600 px up to 600 px down.`;

  return (
    <>
      <PanelSectionRow>
        {isGamepadUI ? (
          <SliderField
            className="heroNativeSlider"
            label={`${axisLabel} offset`}
            description={description}
            value={offset}
            min={OFFSET_MIN}
            max={OFFSET_MAX}
            step={OFFSET_STEP}
            showValue
            editableValue
            valueSuffix=" px"
            resetValue={DEFAULT_OFFSET}
            bottomSeparator="none"
            onChange={onChange}
          />
        ) : (
          <div className="heroQamSliderField">
            <div className="heroQamSliderHeader">
              <span className="heroQamSliderLabel">{axisLabel} offset</span>
              <div className="heroQamSliderValue">
                <input
                  type="number"
                  min={OFFSET_MIN}
                  max={OFFSET_MAX}
                  step={OFFSET_STEP}
                  value={offset}
                  aria-label={`${label} ${axis} offset in pixels`}
                  onInput={(event) => onChange(Number(event.currentTarget.value))}
                  onChange={(event) => onChange(Number(event.currentTarget.value))}
                />
                <span>px</span>
              </div>
            </div>
            <div className="heroQamSliderTrack" style={{ ['--hero-slider-progress' as string]: `${sliderProgress}%` }}>
              <span className="heroQamSliderMarker" />
              <input
                className="heroQamSliderInput"
                type="range"
                min={OFFSET_MIN}
                max={OFFSET_MAX}
                step={OFFSET_STEP}
                value={offset}
                aria-label={`${label} ${axis} offset`}
                onInput={(event) => onChange(Number(event.currentTarget.value))}
                onChange={(event) => onChange(Number(event.currentTarget.value))}
              />
            </div>
            <div className="heroQamSliderDescription">{description}</div>
          </div>
        )}
      </PanelSectionRow>

      <PanelSectionRow>
        <div className="heroNativeActions">
          <DialogButton onClick={() => onChange(offset - 10)}>
            {axis === 'horizontal' ? 'Move left 10 px' : 'Move up 10 px'}
          </DialogButton>
          <DialogButton onClick={() => onChange(offset + 10)}>
            {axis === 'horizontal' ? 'Move right 10 px' : 'Move down 10 px'}
          </DialogButton>
          <DialogButton className="heroCenterButton" onClick={onReset}>
            {axis === 'horizontal' ? 'Center horizontally' : 'Center vertically'}
          </DialogButton>
        </div>
      </PanelSectionRow>
    </>
  );
};

export const HeroPositionContent = ({ initialAppId }: { initialAppId?: string }) => {
  const resolvedAppId = useMemo(() => normalizeAppIdText(initialAppId) ?? fallbackAppIdText() ?? '', [initialAppId]);
  const [appid, setAppid] = useState(resolvedAppId);
  const [offsets, setOffsets] = useState<HeroOffsets>(() => readOffsets());
  const [uiMode, setUiMode] = useState<EUIMode>(EUIMode.Desktop);
  const bigPictureHorizontal = appid ? offsetForMode(offsets, appid, 'bigpicture', 'horizontal') : DEFAULT_OFFSET;
  const bigPictureVertical = appid ? offsetForMode(offsets, appid, 'bigpicture', 'vertical') : DEFAULT_OFFSET;
  const desktopHorizontal = appid ? offsetForMode(offsets, appid, 'desktop', 'horizontal') : DEFAULT_OFFSET;
  const desktopVertical = appid ? offsetForMode(offsets, appid, 'desktop', 'vertical') : DEFAULT_OFFSET;
  const isGamepadUI = isGamepadUIMode(uiMode);

  useEffect(() => {
    void SteamClient.UI.GetUIMode().then(setUiMode).catch(() => setUiMode(EUIMode.Desktop));
  }, []);

  useEffect(() => {
    if (!appid) {
      return;
    }
    rememberLastAppId(appid);
  }, [appid]);

  useEffect(() => {
    const syncCurrentAppId = () => {
      const currentAppId = fallbackAppIdText();
      if (currentAppId) {
        setAppid((previous) => previous === currentAppId ? previous : currentAppId);
      }
    };

    syncCurrentAppId();
    const timer = window.setInterval(syncCurrentAppId, RUNTIME_WATCHDOG_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = readOffsets();
      setOffsets(next);
      setAppid((current) => current || fallbackAppIdText() || '');
    };

    void mergeBackendOffsets().then((next) => {
      setOffsets(next);
      setAppid((current) => current || fallbackAppIdText() || '');
    });
    window.addEventListener('hero-position:offsets-changed', sync);
    return () => window.removeEventListener('hero-position:offsets-changed', sync);
  }, []);

  const setOffset = (mode: HeroMode, axis: HeroAxis, nextOffset: number) => {
    if (!appid) {
      return;
    }

    const key = offsetKeyForMode(appid, mode, axis);
    const next = { ...readOffsets(), [key]: clampOffset(nextOffset) };
    if (next[key] === DEFAULT_OFFSET) {
      delete next[key];
    }
    setOffsets(next);
    writeOffsets(next);
    scheduleOffsetsSave(key, next[key] ?? DEFAULT_OFFSET, next, () => {
      toaster.toast({
        title: 'Hero Position',
        body: `Could not save the ${mode === 'desktop' ? 'Desktop' : 'Big Picture'} ${axis} offset to disk.`,
        icon: <IconsModule.Image />,
        duration: 2400,
      });
    });
  };

  const resetOffset = (mode: HeroMode, axis: HeroAxis) => {
    if (!appid) {
      return;
    }

    const key = offsetKeyForMode(appid, mode, axis);
    const next = { ...readOffsets() };
    delete next[key];
    setOffsets(next);
    writeOffsets(next);
    scheduleOffsetsSave(key, DEFAULT_OFFSET, next, () => {
      toaster.toast({
        title: 'Hero Position',
        body: `Could not save the ${mode === 'desktop' ? 'Desktop' : 'Big Picture'} ${axis} reset to disk.`,
        icon: <IconsModule.Image />,
        duration: 2400,
      });
    });
    toaster.toast({
      title: 'Hero Position Reset',
      body: `${mode === 'desktop' ? 'Desktop' : 'Big Picture'} ${axis} position was centered for ${appid}.`,
      icon: <IconsModule.Image />,
      duration: 1800,
    });
  };

  return (
    <div className="heroSettingsPage">
      <style>{settingsStyles}</style>
      <PanelSection title="CURRENT GAME">
        <PanelSectionRow>
          <div className="heroCurrentGameRow">
            <div>{appid ? `App ${appid}` : 'No Steam app selected'}</div>
          </div>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="BIG PICTURE POSITION">
        <HeroOffsetControl
          label="Big Picture"
          axis="horizontal"
          offset={bigPictureHorizontal}
          isGamepadUI={isGamepadUI}
          onChange={(value) => setOffset('bigpicture', 'horizontal', value)}
          onReset={() => resetOffset('bigpicture', 'horizontal')}
        />
        <HeroOffsetControl
          label="Big Picture"
          axis="vertical"
          offset={bigPictureVertical}
          isGamepadUI={isGamepadUI}
          onChange={(value) => setOffset('bigpicture', 'vertical', value)}
          onReset={() => resetOffset('bigpicture', 'vertical')}
        />
      </PanelSection>

      <PanelSection title="DESKTOP POSITION">
        <HeroOffsetControl
          label="Desktop"
          axis="horizontal"
          offset={desktopHorizontal}
          isGamepadUI={isGamepadUI}
          onChange={(value) => setOffset('desktop', 'horizontal', value)}
          onReset={() => resetOffset('desktop', 'horizontal')}
        />
        <HeroOffsetControl
          label="Desktop"
          axis="vertical"
          offset={desktopVertical}
          isGamepadUI={isGamepadUI}
          onChange={(value) => setOffset('desktop', 'vertical', value)}
          onReset={() => resetOffset('desktop', 'vertical')}
        />
      </PanelSection>
    </div>
  );
};

const HeroPositionRoute = () => {
  const { appid } = useParams<{ appid: string }>();
  return <HeroPositionContent initialAppId={appid} />;
};

function openHeroPosition() {
  return {
    SteamButton: (): any => <IconsModule.Image height="20px" />,
  };
}

Millennium?.exposeObj?.({ openHeroPosition });

const openHeroPositionForApp = async (appid: number) => {
  rememberLastAppId(appid);
  const mode = await SteamClient.UI.GetUIMode().catch(() => EUIMode.Desktop);
  if (isGamepadUIMode(mode)) {
    Navigation.Navigate(`/hero-position/${appid}`);
    return;
  }

  showModal(<HeroPositionContent initialAppId={String(appid)} />, window, {
    strTitle: 'Hero Position',
    bHideMainWindowForPopouts: false,
    bForcePopOut: true,
    popupHeight: 360,
    popupWidth: 780,
  });
};

const menuItemText = (item: Element) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const appIdFromArtwork = (targetDocument: Document) => {
  const artworkPatterns = [
    /\/customimages\/(\d+)_(?:logo|hero)\./,
    /\/assets\/(\d+)\//,
    /\/steam\/apps\/(\d+)\//,
  ];

  const candidates = Array.from(targetDocument.querySelectorAll<HTMLImageElement>('img'))
    .map((image) => {
      const source = image.currentSrc || image.getAttribute('src') || '';
      const appid = artworkPatterns.reduce<string | null>(
        (found, pattern) => found ?? normalizeAppIdText(source.match(pattern)?.[1]),
        null,
      );
      if (!appid) {
        return null;
      }

      const bounds = image.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(bounds.right, targetDocument.documentElement.clientWidth) - Math.max(bounds.left, 0));
      const visibleHeight = Math.max(0, Math.min(bounds.bottom, targetDocument.documentElement.clientHeight) - Math.max(bounds.top, 0));
      return { appid, visibleArea: visibleWidth * visibleHeight };
    })
    .filter((candidate): candidate is { appid: string; visibleArea: number } => Boolean(candidate?.visibleArea))
    .sort((left, right) => right.visibleArea - left.visibleArea);

  return candidates[0]?.appid ?? null;
};

const appIdFromBigPictureDocument = (targetDocument: Document) => {
  try {
    const targetWindow = targetDocument.defaultView as (Window & { uiStore?: any }) | null;
    const routeAppId = appIdFromRouteText(targetWindow?.location.pathname);
    if (routeAppId) {
      return routeAppId;
    }

    const targetGlobal = targetWindow as any;
    const managerAppId = appIdFromRouteText(targetGlobal?.MainWindowBrowserManager?.m_lastLocation?.pathname)
      ?? appIdFromRouteText((globalThis as any).MainWindowBrowserManager?.m_lastLocation?.pathname);
    if (managerAppId) {
      return managerAppId;
    }

    const selectedAppId = normalizeAppIdText(targetWindow?.uiStore?.currentGameListSelection?.nAppId)
      ?? normalizeAppIdText((globalThis as any).uiStore?.currentGameListSelection?.nAppId);
    if (selectedAppId) {
      return selectedAppId;
    }

    const artworkAppId = appIdFromArtwork(targetDocument);
    if (artworkAppId) {
      return artworkAppId;
    }

    const entries = (targetWindow?.history.state as { memoryhistory?: { initialEntries?: unknown[] } } | null)
      ?.memoryhistory?.initialEntries;
    if (Array.isArray(entries)) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const historyAppId = appIdFromRouteText(entries[index]);
        if (historyAppId) {
          return historyAppId;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
};

const resolveCurrentAppId = (targetDocument: Document) =>
  appIdFromBigPictureDocument(targetDocument) ?? fallbackAppIdText();

const directMenuItems = (parent: Element) =>
  Array.from(parent.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'));

const findRootAppMenu = (targetDocument: Document) => {
  const parents = new Set<Element>();
  for (const item of targetDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    if (item.parentElement?.closest('.BasicUIContextMenu')) {
      parents.add(item.parentElement);
    }
  }

  return Array.from(parents).find((parent) => {
    const labels = directMenuItems(parent).map(menuItemText);
    return labels.includes('Manage') && (labels.includes('Properties...') || labels.includes('Cancel'));
  }) ?? null;
};

const reconcileHeroPositionMenu = (targetDocument: Document) => {
  const rootMenu = findRootAppMenu(targetDocument);
  const allHeroItems = Array.from(targetDocument.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((item) => menuItemText(item) === MENU_ITEM_TEXT);

  if (!rootMenu) {
    for (const item of allHeroItems) {
      if (item.classList.contains(MENU_ITEM_CLASS)) item.remove();
    }
    return;
  }

  let rootItem: HTMLElement | null = null;
  for (const item of allHeroItems) {
    if (item.parentElement === rootMenu && item.classList.contains(MENU_ITEM_CLASS) && !rootItem) {
      rootItem = item;
    } else {
      item.remove();
    }
  }

  const openEditor = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const appid = resolveCurrentAppId(targetDocument);
    if (!appid) {
      toaster.toast({
        title: 'Hero Position',
        body: 'Could not determine the selected Steam app.',
        icon: <IconsModule.Image />,
        duration: 2400,
      });
      return;
    }
    rememberLastAppId(appid);
    const cancelItem = directMenuItems(rootMenu).find((item) => menuItemText(item) === 'Cancel');
    if (cancelItem) {
      cancelItem.click();
    } else {
      const popup = rootMenu.closest<HTMLElement>('.BasicUIContextMenu');
      if (popup) popup.style.display = 'none';
    }
    window.setTimeout((): void => void openHeroPositionForApp(Number(appid)), 0);
  };

  if (rootItem) {
    rootItem.onclick = openEditor;
    return;
  }

  const items = directMenuItems(rootMenu);
  const reference = items.find((item) => menuItemText(item) === 'Properties...')
    ?? items.find((item) => menuItemText(item) === 'Cancel');
  if (!reference) {
    return;
  }

  rootItem = reference.cloneNode(false) as HTMLElement;
  rootItem.classList.add(MENU_ITEM_CLASS);
  rootItem.dataset.heroPositionMenuItem = 'true';
  rootItem.textContent = MENU_ITEM_TEXT;
  rootItem.onclick = openEditor;
  rootMenu.insertBefore(rootItem, reference);
};

const menuDocumentSubscriptions = new Map<Document, () => void>();
const queuedMenuDocuments = new WeakSet<Document>();
let runtimeWatchdog: number | undefined;

const scheduleMenuReconcile = (targetDocument: Document) => {
  if (queuedMenuDocuments.has(targetDocument)) return;
  queuedMenuDocuments.add(targetDocument);
  (targetDocument.defaultView ?? window).queueMicrotask(() => {
    queuedMenuDocuments.delete(targetDocument);
    reconcileHeroPositionMenu(targetDocument);
  });
};

const observeArtworkMenus = (targetDocument: Document) => {
  if (menuDocumentSubscriptions.has(targetDocument)) {
    scheduleMenuReconcile(targetDocument);
    return;
  }

  menuDocumentSubscriptions.set(
    targetDocument,
    subscribeToDocument(targetDocument, () => scheduleMenuReconcile(targetDocument)),
  );
};

const ensureBigPictureIntegration = () => {
  const bigPictureDocument = getBigPictureDocument();
  const desktopDocument = getDesktopDocument();
  const offsets = readOffsets();
  applyHeroPositionStyles(offsets, bigPictureDocument, 'bigpicture');
  applyHeroPositionStyles(offsets, desktopDocument, 'desktop');
  if (bigPictureDocument) {
    observeArtworkMenus(bigPictureDocument);
  }
  if (desktopDocument) observeArtworkMenus(desktopDocument);
};

export const attachHeroToPopup = (popup: any) => {
  const targetDocument = popup?.m_popup?.document as Document | undefined;
  const popupName = String(popup?.m_strName ?? '');
  if (!targetDocument) {
    return;
  }

  if (popupName.startsWith('SP BPM_') || targetDocument.title === 'Steam Big Picture Mode') {
    hookedBigPictureDocument = targetDocument;
  } else if (popupName.startsWith('SP Desktop_') || targetDocument.title === 'Steam') {
    hookedDesktopDocument = targetDocument;
  } else {
    return;
  }
  window.setTimeout(ensureBigPictureIntegration, 0);
};

const startBigPictureIntegration = () => {
  ensureBigPictureIntegration();
  if (runtimeWatchdog === undefined) {
    runtimeWatchdog = window.setInterval(ensureBigPictureIntegration, RUNTIME_WATCHDOG_MS);
  }
};

export const stopHeroModule = () => {
  routerHook.removeRoute('/hero-position/:appid');
  if (runtimeWatchdog !== undefined) {
    window.clearInterval(runtimeWatchdog);
    runtimeWatchdog = undefined;
  }
  menuDocumentSubscriptions.forEach((unsubscribe, targetDocument) => {
    unsubscribe();
    targetDocument.querySelectorAll(`.${MENU_ITEM_CLASS}`).forEach((item) => item.remove());
  });
  menuDocumentSubscriptions.clear();
  injectedStyleDocuments.forEach((targetDocument) => targetDocument.getElementById(RUNTIME_STYLE_ID)?.remove());
  injectedStyleDocuments.forEach((targetDocument) => {
    targetDocument.querySelectorAll<HTMLImageElement>(`[${DESKTOP_APPLIED_ATTRIBUTE}]`).forEach(restoreDesktopHeroImage);
  });
  injectedStyleDocuments.clear();
  hookedBigPictureDocument = null;
  hookedDesktopDocument = null;
};

export function initializeHeroModule() {
  if (!window.localStorage.getItem(STORAGE_KEY)) {
    const legacyOffsets = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyOffsets) window.localStorage.setItem(STORAGE_KEY, legacyOffsets);
  }
  if (!window.localStorage.getItem(LAST_APPID_STORAGE_KEY)) {
    const legacyAppId = window.localStorage.getItem(LEGACY_LAST_APPID_STORAGE_KEY);
    if (legacyAppId) window.localStorage.setItem(LAST_APPID_STORAGE_KEY, legacyAppId);
  }

  routerHook.removeRoute('/hero-position/:appid');
  routerHook.addRoute('/hero-position/:appid', HeroPositionRoute, { exact: true });
  startBigPictureIntegration();
  void mergeBackendOffsets().then(ensureBigPictureIntegration);
  console.log('[artwork-positioner] Hero offsets loaded');
}
