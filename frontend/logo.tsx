import { callable, findModule, DialogButton, Field, TextField, Toggle } from "@steambrew/client";
import { createRoot } from "react-dom/client";
import React, { useState, useEffect } from "react";
import { subscribeToDocument } from "./window-runtime";

declare global {
    var uiStore: any;
}

type PluginConfig = {
    context_menu: boolean;
    show_button: boolean;
}

var pluginConfig: PluginConfig = {
    context_menu: true,
    show_button: true
};

const LOGO_CONFIG_KEY = "artwork-positioner:logo:config:v1";
const LOGO_DATABASE_KEY = "artwork-positioner:logo:positions:v1";
const LEGACY_LOGO_CONFIG_KEY = "luthor112.steam-logo-pos.config";
const LEGACY_LOGO_DATABASE_KEY = "luthor112.steam-logo-pos.posdb";

type LegacyPosition = number[];

type PercentPosition = {
    unit: "percent";
    x: number;
    y: number;
    width?: number;
    height?: number;
};

type PosDB = Record<string, LegacyPosition | PercentPosition>;

type PersistedLogoData = {
    version: 1;
    config: Partial<PluginConfig>;
    positions: PosDB;
};

type SetLogoDataParams = { data_json: string };

const getLogoData = callable<[], string | false>("get_logo_data");
const setLogoData = callable<[SetLogoDataParams], string | false>("set_logo_data");

var posDB: PosDB = {};
let logoDataSaveQueued = false;
let logoDataSaveChain: Promise<void> = Promise.resolve();

function currentPersistedLogoData(): PersistedLogoData {
    return {
        version: 1,
        config: { ...pluginConfig },
        positions: { ...posDB },
    };
}

function scheduleLogoDataSave() {
    if (logoDataSaveQueued) {
        return;
    }
    logoDataSaveQueued = true;
    window.queueMicrotask(() => {
        logoDataSaveQueued = false;
        const snapshot = currentPersistedLogoData();
        logoDataSaveChain = logoDataSaveChain
            .catch((): void => undefined)
            .then(async () => {
                const response = await setLogoData({ data_json: JSON.stringify(snapshot) });
                if (response === false) throw new Error("logo_backend_unavailable");
                const parsed = JSON.parse(response) as { ok?: boolean; error?: string };
                if (!parsed.ok) throw new Error(parsed.error || "logo_data_save_failed");
            })
            .catch((error) => console.error("[artwork-positioner] Could not persist Logo data", error));
    });
}

function savePositionDatabase() {
    localStorage.setItem(LOGO_DATABASE_KEY, JSON.stringify(posDB));
    scheduleLogoDataSave();
}

function parseStoredObject<T>(rawValue: string | null, fallback: T): T {
    if (!rawValue) {
        return fallback;
    }
    try {
        const parsed = JSON.parse(rawValue);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
    } catch (error) {
        console.warn("[steam-logo-pos] Ignoring invalid stored JSON", error);
        return fallback;
    }
}

function setPercentPosition(positionKey: string, position: PercentPosition) {
    posDB[positionKey] = position;
    savePositionDatabase();
}

function isPercentPosition(position: LegacyPosition | PercentPosition | undefined): position is PercentPosition {
    return position !== undefined
        && !Array.isArray(position)
        && position.unit === "percent"
        && Number.isFinite(position.x)
        && Number.isFinite(position.y);
}

function clampLogoTopAbovePlaybar(logoElement: HTMLElement, topCapsuleDiv: HTMLElement, nextTop: number) {
    const logoRect = logoElement.getBoundingClientRect();
    const topCapsuleRect = topCapsuleDiv.getBoundingClientRect();
    if (!Number.isFinite(nextTop) || logoRect.width <= 0 || logoRect.height <= 0 || topCapsuleRect.height <= 0) {
        return nextTop;
    }
    const maxTop = logoElement.offsetTop + (topCapsuleRect.bottom - logoRect.bottom);
    if (!Number.isFinite(maxTop)) {
        return nextTop;
    }
    return Math.min(nextTop, maxTop);
}

function isLogoVisibleInTopCapsule(logoElement: HTMLElement, topCapsuleDiv: HTMLElement, top: number) {
    const logoRect = logoElement.getBoundingClientRect();
    const topCapsuleRect = topCapsuleDiv.getBoundingClientRect();
    if (!Number.isFinite(top) || logoRect.width <= 0 || logoRect.height <= 0 || topCapsuleRect.height <= 0) {
        return true;
    }
    const deltaTop = top - logoElement.offsetTop;
    const nextBottom = logoRect.bottom + deltaTop;
    return nextBottom > topCapsuleRect.top;
}

function isVisibleElement(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const view = element.ownerDocument.defaultView;
    return element.isConnected
        && rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < (view?.innerHeight ?? Number.POSITIVE_INFINITY)
        && rect.left < (view?.innerWidth ?? Number.POSITIVE_INFINITY)
        && style?.display !== "none"
        && style?.visibility !== "hidden";
}

function readDesktopAppId() {
    try {
        const appId = Number(uiStore?.currentGameListSelection?.nAppId);
        return Number.isFinite(appId) && appId > 0 ? appId : null;
    } catch {
        return null;
    }
}

function readBigPictureAppId(popupDocument: Document) {
    const artworkPatterns = [
        /\/customimages\/(\d+)_(?:logo|hero)\./,
        /\/assets\/(\d+)\//,
        /\/steam\/apps\/(\d+)\//,
    ];
    for (const image of Array.from(popupDocument.querySelectorAll("img"))) {
        const source = image.getAttribute("src") ?? "";
        for (const pattern of artworkPatterns) {
            const match = source.match(pattern);
            const appId = Number(match?.[1]);
            if (Number.isFinite(appId) && appId > 0) {
                return appId;
            }
        }
    }
    return null;
}

type LogoElements = {
    appId: number;
    logo: HTMLElement;
    topCapsule: HTMLElement;
    positionParent: HTMLElement;
};

type InlineStyleValue = {
    value: string;
    priority: string;
};

type LogoStyleSnapshot = Record<"left" | "top" | "width" | "height", InlineStyleValue>;

type LogoRuntimeState =
    | { kind: "idle" }
    | { kind: "plugin"; appId: number; draft: PercentPosition }
    | { kind: "steam"; appId: number; logo: HTMLElement; draft: PercentPosition };

const refreshControllers = new Set<() => void>();
const disposeControllers = new Map<Document, () => void>();

export async function attachLogoToPopup(popup: any) {
    const isBigPicture = popup.m_strName.startsWith("SP BPM_");
    const isDesktop = popup.m_strName.startsWith("SP Desktop_");
    if (!isDesktop && !isBigPicture) {
        return;
    }
    const popupWindow = popup.m_popup as Window;
    const popupDocument = popupWindow.document;
    if (!popupDocument.body) {
        popupDocument.addEventListener("DOMContentLoaded", () => void attachLogoToPopup(popup), { once: true });
        return;
    }
    let activeElements: LogoElements | null = null;
    disposeControllers.get(popupDocument)?.();
    let runtimeState: LogoRuntimeState = { kind: "idle" };
    let detachDragHandler: (() => void) | null = null;
    let detachResizeHandlers: (() => void) | null = null;
    let reconcileQueued = false;
    let observedLogo: HTMLElement | null = null;
    const originalLogoStyles = new WeakMap<HTMLElement, LogoStyleSnapshot>();

    let logoClasses: any = null;
    let pageClasses: any = null;
    let menuButtonClasses: any = null;

    const readCurrentAppId = () => isBigPicture
        ? readBigPictureAppId(popupDocument)
        : readDesktopAppId();
    const getPositionKey = (appId: number) => isBigPicture
        ? `bigpicture:${appId}`
        : appId.toString();

    const resolveSteamModules = () => {
        logoClasses ??= findModule((module: any) => module.BoxSizer && module.TopCapsule && module.BoxSizerValidRegion);
        pageClasses ??= findModule((module: any) => module.InPage && module.AppButtonsContainer);
        menuButtonClasses ??= findModule((module: any) => module.MenuButtonContainer);
        return Boolean(logoClasses && (isBigPicture || (pageClasses && menuButtonClasses)));
    };

    const toPercent = (pixels: number, size: number) => size > 0 ? pixels / size * 100 : 0;

    const captureOriginalLogoStyle = (logo: HTMLElement) => {
        if (originalLogoStyles.has(logo)) {
            return;
        }
        const read = (property: keyof LogoStyleSnapshot): InlineStyleValue => ({
            value: logo.style.getPropertyValue(property),
            priority: logo.style.getPropertyPriority(property),
        });
        originalLogoStyles.set(logo, {
            left: read("left"),
            top: read("top"),
            width: read("width"),
            height: read("height"),
        });
    };

    const restoreOriginalLogoStyle = (logo: HTMLElement) => {
        const snapshot = originalLogoStyles.get(logo);
        if (!snapshot) {
            return;
        }
        (Object.keys(snapshot) as Array<keyof LogoStyleSnapshot>).forEach((property) => {
            const original = snapshot[property];
            logo.style.removeProperty(property);
            if (original.value) {
                logo.style.setProperty(property, original.value, original.priority);
            }
        });
        originalLogoStyles.delete(logo);
    };

    const readCurrentPercentPosition = (elements: LogoElements): PercentPosition => ({
        unit: "percent",
        x: toPercent(elements.logo.offsetLeft, elements.positionParent.clientWidth),
        y: toPercent(elements.logo.offsetTop, elements.positionParent.clientHeight),
        width: toPercent(elements.logo.offsetWidth, elements.positionParent.clientWidth),
        height: toPercent(elements.logo.offsetHeight, elements.positionParent.clientHeight),
    });

    const writePercentPosition = (elements: LogoElements, position: PercentPosition) => {
        const parentWidth = elements.positionParent.clientWidth;
        const parentHeight = elements.positionParent.clientHeight;
        if (parentWidth <= 0 || parentHeight <= 0) {
            return null;
        }

        if (Number.isFinite(position.width) && position.width! > 0) {
            const widthStyle = `${position.width}%`;
            const nextWidth = position.width! / 100 * parentWidth;
            if (Math.abs(elements.logo.offsetWidth - nextWidth) > 0.5) {
                elements.logo.style.width = widthStyle;
            }
        }
        if (Number.isFinite(position.height) && position.height! > 0) {
            const heightStyle = `${position.height}%`;
            const nextHeight = position.height! / 100 * parentHeight;
            if (Math.abs(elements.logo.offsetHeight - nextHeight) > 0.5) {
                elements.logo.style.height = heightStyle;
            }
        }

        const nextLeft = position.x / 100 * parentWidth;
        const requestedTop = position.y / 100 * parentHeight;
        const clampedTop = clampLogoTopAbovePlaybar(elements.logo, elements.topCapsule, requestedTop);
        const appliedPosition: PercentPosition = {
            unit: "percent",
            x: toPercent(nextLeft, parentWidth),
            y: toPercent(clampedTop, parentHeight),
            width: Number.isFinite(position.width) ? position.width : undefined,
            height: Number.isFinite(position.height) ? position.height : undefined,
        };
        const leftStyle = `${appliedPosition.x}%`;
        const topStyle = `${appliedPosition.y}%`;
        if (Math.abs(elements.logo.offsetLeft - nextLeft) > 0.5) {
            elements.logo.style.left = leftStyle;
        }
        if (Math.abs(elements.logo.offsetTop - clampedTop) > 0.5) {
            elements.logo.style.top = topStyle;
        }
        return appliedPosition;
    };

    const resolveStoredPosition = (elements: LogoElements) => {
        const stored = posDB[getPositionKey(elements.appId)];
        if (isPercentPosition(stored)) {
            return { position: stored, migrated: false };
        }
        if (!Array.isArray(stored)) {
            return null;
        }

        const current = readCurrentPercentPosition(elements);
        const legacyX = Number(stored[0]);
        const legacyY = Number(stored[1]);
        const parentWidth = elements.positionParent.clientWidth;
        const parentHeight = elements.positionParent.clientHeight;
        const position: PercentPosition = {
            unit: "percent",
            x: Number.isFinite(legacyX) && legacyX !== -1 ? toPercent(legacyX, parentWidth) : current.x,
            y: Number.isFinite(legacyY) && legacyY !== -1 ? toPercent(legacyY, parentHeight) : current.y,
        };

        const requestedTop = position.y / 100 * parentHeight;
        if (!isLogoVisibleInTopCapsule(elements.logo, elements.topCapsule, requestedTop)) {
            position.y = current.y;
        }
        return { position, migrated: true };
    };

    const applyStoredPosition = (elements: LogoElements, maskFirstApply: boolean) => {
        if (runtimeState.kind === "plugin" && runtimeState.appId === elements.appId) {
            writePercentPosition(elements, runtimeState.draft);
            return;
        }

        const resolved = resolveStoredPosition(elements);
        if (!resolved) {
            return;
        }
        if (maskFirstApply) {
            elements.logo.style.visibility = "hidden";
        }
        captureOriginalLogoStyle(elements.logo);
        const applied = writePercentPosition(elements, resolved.position);
        if (applied) {
            elements.logo.dataset.logoposAppliedAppId = elements.appId.toString();
            if (resolved.migrated) {
                setPercentPosition(getPositionKey(elements.appId), applied);
                console.log("[steam-logo-pos] Migrated logo position to percentages", elements.appId, applied);
            }
        }
        if (maskFirstApply) {
            popupWindow.queueMicrotask(() => {
                if (elements.logo.isConnected) {
                    elements.logo.style.visibility = "";
                }
            });
        }
    };

    const findCurrentLogoElements = (): LogoElements | null => {
        if (!resolveSteamModules()) {
            return null;
        }
        const appId = readCurrentAppId();
        if (appId === null) {
            return null;
        }

        const topCapsules = Array.from(popupDocument.querySelectorAll(`div.${logoClasses.TopCapsule}`)) as HTMLElement[];
        const matchingCapsules = topCapsules.filter((capsule) => {
            if (!isVisibleElement(capsule)) {
                return false;
            }
            const imageSources = Array.from(capsule.querySelectorAll("img"))
                .map((image) => image.getAttribute("src") ?? "")
                .filter(Boolean);
            if (imageSources.length === 0) {
                return true;
            }
            const appPathPattern = new RegExp(`(?:/|_)${appId}(?:/|_|\\.|$)`);
            return imageSources.some((source) => appPathPattern.test(source));
        });
        const topCapsule = matchingCapsules[matchingCapsules.length - 1];
        if (!topCapsule) {
            return null;
        }

        const logos = Array.from(topCapsule.querySelectorAll(`div.${logoClasses.BoxSizer}`)) as HTMLElement[];
        const logo = logos.find(isVisibleElement) ?? logos[0];
        if (!logo || !logo.isConnected) {
            return null;
        }
        const validRegion = logo.closest(`div.${logoClasses.BoxSizerValidRegion}`) as HTMLElement | null;
        const positionParent = (logo.offsetParent as HTMLElement | null) ?? validRegion;
        if (!positionParent || positionParent.clientWidth <= 0 || positionParent.clientHeight <= 0) {
            return null;
        }
        return { appId, logo, topCapsule, positionParent };
    };

    const hideDoneButtons = () => {
        popupDocument.querySelectorAll<HTMLElement>(".logo-move-done-button").forEach((button) => {
            button.style.display = "none";
        });
    };

    const saveEditDraft = () => {
        if (runtimeState.kind === "plugin") {
            setPercentPosition(getPositionKey(runtimeState.appId), runtimeState.draft);
        }
    };

    const stopEditing = (saveDraft: boolean) => {
        if (saveDraft && runtimeState.kind === "plugin") {
            saveEditDraft();
        }
        runtimeState = { kind: "idle" };
        detachDragHandler?.();
        detachDragHandler = null;
        detachResizeHandlers?.();
        detachResizeHandlers = null;
        hideDoneButtons();
        queueReconcile();
    };

    const endEditing = () => stopEditing(true);

    const relinquishCurrentPosition = () => {
        const appId = readCurrentAppId();
        stopEditing(false);
        if (appId === null) {
            return;
        }
        delete posDB[getPositionKey(appId)];
        savePositionDatabase();
        if (activeElements?.appId === appId) {
            restoreOriginalLogoStyle(activeElements.logo);
            delete activeElements.logo.dataset.logoposAppliedAppId;
        }
        console.log("[steam-logo-pos] Relinquished custom position to Steam", appId);
    };

    const beginSteamAdjustment = (elements: LogoElements) => {
        const current = readCurrentPercentPosition(elements);
        const stored = posDB[getPositionKey(elements.appId)];
        const base = isPercentPosition(stored) ? stored : current;
        runtimeState = {
            kind: "steam",
            appId: elements.appId,
            logo: elements.logo,
            draft: {
                ...base,
                width: current.width,
                height: current.height,
            },
        };
        detachDragHandler?.();
        detachDragHandler = null;
        detachResizeHandlers?.();
        detachResizeHandlers = null;
        hideDoneButtons();
    };

    const updateSteamAdjustment = (elements: LogoElements) => {
        if (runtimeState.kind !== "steam"
            || runtimeState.appId !== elements.appId
            || runtimeState.logo !== elements.logo) {
            beginSteamAdjustment(elements);
            return;
        }
        const current = readCurrentPercentPosition(elements);
        runtimeState = {
            ...runtimeState,
            draft: {
                ...runtimeState.draft,
                width: current.width,
                height: current.height,
            },
        };
    };

    const finishSteamAdjustment = () => {
        if (runtimeState.kind !== "steam") {
            return;
        }
        setPercentPosition(getPositionKey(runtimeState.appId), runtimeState.draft);
        console.log("[artwork-positioner] Saved Steam logo adjustment", runtimeState.appId, runtimeState.draft);
        runtimeState = { kind: "idle" };
    };

    const isSteamAdjustmentVisible = (elements: LogoElements) => {
        const classNames = [
            logoClasses?.BoxSizerDragBox,
            logoClasses?.SaveBoxSizer,
            logoClasses?.BoxSizerGridBox,
        ].filter((className): className is string => Boolean(className));
        return classNames.some((className) =>
            Array.from(elements.topCapsule.querySelectorAll<HTMLElement>(`.${className}`))
                .some((node) => !node.closest(".logo-resize-grid"))
        );
    };

    const closeContextMenu = (menuItemContainer: HTMLElement) => {
        if (isBigPicture) {
            const cancelItem = Array.from(menuItemContainer.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find((item) => item.textContent?.trim() === "Cancel");
            if (cancelItem) {
                cancelItem.click();
                return;
            }
        }
        const menuPopup = (menuItemContainer.closest(".BasicUIContextMenu")
            ?? menuItemContainer.parentElement) as HTMLElement | null;
        if (!menuPopup) {
            return;
        }
        menuPopup.dataset.logoPositionerHidden = "true";
        menuPopup.style.display = "none";
    };

    const ensureDoneButton = (elements: LogoElements) => {
        const buttonHost = isBigPicture ? popupDocument.body : elements.topCapsule;
        let doneButton = buttonHost.querySelector("div.logo-move-done-button") as HTMLElement | null;
        if (!doneButton) {
            doneButton = popupDocument.createElement("div");
            doneButton.className = "logo-move-done-button";
            doneButton.style.position = isBigPicture ? "fixed" : "absolute";
            doneButton.style.right = isBigPicture ? "32px" : "20px";
            doneButton.style.top = isBigPicture ? "64px" : "";
            doneButton.style.bottom = isBigPicture ? "" : "20px";
            doneButton.style.zIndex = isBigPicture ? "10000" : "100";
            createRoot(doneButton).render(
                <DialogButton style={{width: "fit-content", padding: "0px 20px"}} onClick={endEditing}>Done</DialogButton>
            );
            buttonHost.appendChild(doneButton);
        }
        doneButton.style.display = runtimeState.kind === "plugin" && runtimeState.appId === elements.appId ? "" : "none";
    };

    const attachDragHandler = (elements: LogoElements) => {
        detachDragHandler?.();
        const logo = elements.logo;
        const previousCursor = logo.style.cursor;
        const previousPointerEvents = logo.style.pointerEvents;
        const previousTouchAction = logo.style.touchAction;
        let activePointerId: number | null = null;
        let startClientX = 0;
        let startClientY = 0;
        let startLeft = 0;
        let startTop = 0;

        logo.classList.add("logopos-header");
        logo.style.cursor = "move";
        logo.style.pointerEvents = "auto";
        logo.style.touchAction = "none";

        const onPointerDown = (event: PointerEvent) => {
            if (event.button !== 0 || runtimeState.kind !== "plugin" || runtimeState.appId !== elements.appId) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            activePointerId = event.pointerId;
            startClientX = event.clientX;
            startClientY = event.clientY;
            startLeft = logo.offsetLeft;
            startTop = logo.offsetTop;
            logo.setPointerCapture(event.pointerId);
        };

        const onPointerMove = (event: PointerEvent) => {
            if (activePointerId !== event.pointerId || runtimeState.kind !== "plugin" || runtimeState.appId !== elements.appId) {
                return;
            }
            event.preventDefault();
            const parentWidth = elements.positionParent.clientWidth;
            const parentHeight = elements.positionParent.clientHeight;
            if (parentWidth <= 0 || parentHeight <= 0) {
                return;
            }
            const nextLeft = startLeft + event.clientX - startClientX;
            const requestedTop = startTop + event.clientY - startClientY;
            const nextTop = clampLogoTopAbovePlaybar(logo, elements.topCapsule, requestedTop);
            runtimeState = { ...runtimeState, draft: {
                ...runtimeState.draft,
                x: toPercent(nextLeft, parentWidth),
                y: toPercent(nextTop, parentHeight),
            } };
            writePercentPosition(elements, runtimeState.draft);
        };

        const onPointerEnd = (event: PointerEvent) => {
            if (activePointerId !== event.pointerId) {
                return;
            }
            activePointerId = null;
            if (logo.hasPointerCapture(event.pointerId)) {
                logo.releasePointerCapture(event.pointerId);
            }
            saveEditDraft();
        };

        logo.addEventListener("pointerdown", onPointerDown);
        logo.addEventListener("pointermove", onPointerMove);
        logo.addEventListener("pointerup", onPointerEnd);
        logo.addEventListener("pointercancel", onPointerEnd);

        detachDragHandler = () => {
            logo.removeEventListener("pointerdown", onPointerDown);
            logo.removeEventListener("pointermove", onPointerMove);
            logo.removeEventListener("pointerup", onPointerEnd);
            logo.removeEventListener("pointercancel", onPointerEnd);
            logo.classList.remove("logopos-header");
            logo.style.cursor = previousCursor;
            logo.style.pointerEvents = previousPointerEvents;
            logo.style.touchAction = previousTouchAction;
        };
    };

    const attachResizeHandles = (elements: LogoElements) => {
        detachResizeHandlers?.();
        elements.logo.querySelector(":scope > .logo-resize-grid")?.remove();

        const grid = popupDocument.createElement("div");
        grid.className = `${logoClasses.BoxSizerGridBox} logo-resize-grid`;
        grid.style.position = "absolute";
        grid.style.left = "0";
        grid.style.top = "0";
        grid.style.zIndex = "60";
        grid.style.pointerEvents = "none";

        const edges = [
            ["topleft", logoClasses.TopLeft],
            ["top", logoClasses.Top],
            ["topright", logoClasses.TopRight],
            ["left", logoClasses.Left],
            ["middle", logoClasses.Middle],
            ["right", logoClasses.Right],
            ["bottomleft", logoClasses.BottomLeft],
            ["bottom", logoClasses.Bottom],
            ["bottomright", logoClasses.BottomRight],
        ] as const;
        const cleanups: Array<() => void> = [];

        edges.forEach(([edge, edgeClass]) => {
            const handle = popupDocument.createElement("div");
            handle.className = `${logoClasses.BoxSizerEdge} ${edgeClass}`;
            handle.style.pointerEvents = edge === "middle" ? "none" : "auto";
            handle.draggable = false;
            grid.appendChild(handle);
            if (edge === "middle") {
                return;
            }

            const onPointerDown = (event: PointerEvent) => {
                if (event.button !== 0 || runtimeState.kind !== "plugin" || runtimeState.appId !== elements.appId) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                const startClientX = event.clientX;
                const startClientY = event.clientY;
                const startLeft = elements.logo.offsetLeft;
                const startTop = elements.logo.offsetTop;
                const startWidth = elements.logo.offsetWidth;
                const startHeight = elements.logo.offsetHeight;
                const parentWidth = elements.positionParent.clientWidth;
                const parentHeight = elements.positionParent.clientHeight;
                const parentRect = elements.positionParent.getBoundingClientRect();
                const capsuleRect = elements.topCapsule.getBoundingClientRect();
                const safeBottom = capsuleRect.bottom - parentRect.top;
                const minWidth = Math.max(parentWidth * 0.01, 8);
                const minHeight = Math.max(parentHeight * 0.01, 8);

                const onPointerMove = (moveEvent: PointerEvent) => {
                    moveEvent.preventDefault();
                    moveEvent.stopPropagation();
                    const dx = moveEvent.clientX - startClientX;
                    const dy = moveEvent.clientY - startClientY;
                    let nextLeft = startLeft;
                    let nextTop = startTop;
                    let nextWidth = startWidth;
                    let nextHeight = startHeight;

                    if (edge.includes("left")) {
                        nextWidth = Math.max(minWidth, startWidth - dx);
                        nextLeft = startLeft + startWidth - nextWidth;
                    } else if (edge.includes("right")) {
                        nextWidth = Math.max(minWidth, startWidth + dx);
                    }
                    if (edge.includes("top")) {
                        nextHeight = Math.max(minHeight, startHeight - dy);
                        nextTop = startTop + startHeight - nextHeight;
                    } else if (edge.includes("bottom")) {
                        nextHeight = Math.max(minHeight, Math.min(startHeight + dy, safeBottom - nextTop));
                    }

                    if (runtimeState.kind !== "plugin" || runtimeState.appId !== elements.appId) {
                        return;
                    }
                    runtimeState = { ...runtimeState, draft: {
                        unit: "percent",
                        x: toPercent(nextLeft, parentWidth),
                        y: toPercent(nextTop, parentHeight),
                        width: toPercent(nextWidth, parentWidth),
                        height: toPercent(nextHeight, parentHeight),
                    } };
                    writePercentPosition(elements, runtimeState.draft);
                };
                const onPointerUp = () => {
                    popupWindow.removeEventListener("pointermove", onPointerMove, true);
                    popupWindow.removeEventListener("pointerup", onPointerUp, true);
                    popupWindow.removeEventListener("pointercancel", onPointerUp, true);
                    saveEditDraft();
                };
                popupWindow.addEventListener("pointermove", onPointerMove, true);
                popupWindow.addEventListener("pointerup", onPointerUp, true);
                popupWindow.addEventListener("pointercancel", onPointerUp, true);
            };
            handle.addEventListener("pointerdown", onPointerDown);
            cleanups.push(() => handle.removeEventListener("pointerdown", onPointerDown));
        });

        elements.logo.appendChild(grid);
        detachResizeHandlers = () => {
            cleanups.forEach((cleanup) => cleanup());
            grid.remove();
        };
    };

    const beginEditing = () => {
        const elements = findCurrentLogoElements();
        if (!elements) {
            console.warn("[steam-logo-pos] Cannot move logo because the current logo element was not found");
            return;
        }
        if (runtimeState.kind === "plugin" && runtimeState.appId === elements.appId) {
            endEditing();
            return;
        }
        if (runtimeState.kind === "steam") {
            finishSteamAdjustment();
        } else {
            saveEditDraft();
        }
        captureOriginalLogoStyle(elements.logo);
        runtimeState = {
            kind: "plugin",
            appId: elements.appId,
            draft: readCurrentPercentPosition(elements),
        };
        activeElements = elements;
        attachDragHandler(elements);
        attachResizeHandles(elements);
        ensureDoneButton(elements);
    };

    const ensureMoveButton = () => {
        if (isBigPicture) {
            return;
        }
        if (!resolveSteamModules()) {
            return;
        }
        const existingButtons = Array.from(popupDocument.querySelectorAll<HTMLElement>(".logo-move-button"));
        if (!pluginConfig.show_button) {
            existingButtons.forEach((button) => button.remove());
            return;
        }

        const selector = `div.${pageClasses.InPage} div.${pageClasses.AppButtonsContainer} > div.${menuButtonClasses.MenuButtonContainer}:not([role="button"])`;
        const settingsButtons = Array.from(popupDocument.querySelectorAll(selector)) as HTMLElement[];
        const settingsButton = settingsButtons.find(isVisibleElement);
        if (!settingsButton?.parentElement) {
            return;
        }
        let moveButton = settingsButton.parentElement.querySelector("div.logo-move-button") as HTMLElement | null;
        if (!moveButton) {
            moveButton = settingsButton.cloneNode(true) as HTMLElement;
            moveButton.classList.add("logo-move-button");
            moveButton.title = "Move Logo";
            if (moveButton.firstElementChild) {
                moveButton.firstElementChild.innerHTML = "ML";
            }
            settingsButton.parentElement.insertBefore(moveButton, settingsButton.nextSibling);
        }
        moveButton.onclick = beginEditing;
    };

    const enhanceContextMenus = () => {
        if (!pluginConfig.context_menu) {
            popupDocument.querySelectorAll(".moveLogoAdded").forEach((item) => item.remove());
            return;
        }

        const localization = findModule((module: any) => module.CustomArt_EditLogoPosition);
        const adjustLogoTexts = new Set([
            "Adjust Logo Position",
            localization?.CustomArt_EditLogoPosition,
        ].filter((text): text is string => Boolean(text)));
        const resetLogoTexts = new Set(["Reset Logo Position"]);
        const artworkChangeTexts = new Set([
            "Clear Custom Background",
            "Clear Custom Logo",
        ]);
        const nativeMenuItems = Array.from(
            popupDocument.querySelectorAll<HTMLElement>('[role="menuitem"].contextMenuItem')
        );
        const menuParents = new Set<HTMLElement>();
        popupDocument.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((item) => {
            if (item.parentElement?.closest(".BasicUIContextMenu")) {
                menuParents.add(item.parentElement);
            }
        });
        const gameMenu = Array.from(menuParents).find((container) => {
            const labels = Array.from(container.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'))
                .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "");
            return labels.includes("Manage") && (labels.includes("Properties...") || labels.includes("Cancel"));
        });
        if (gameMenu) {
            const existingItem = gameMenu.querySelector<HTMLElement>(":scope > .moveLogoAdded");
            const heroItem = Array.from(gameMenu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'))
                .find((item) => item.textContent?.trim() === "Adjust Hero Position...");
            if (existingItem) {
                if (heroItem && heroItem.nextElementSibling !== existingItem) {
                    heroItem.insertAdjacentElement("afterend", existingItem);
                }
            } else {
                const anchor = Array.from(gameMenu.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'))
                    .find((item) => ["Adjust Hero Position...", "Properties...", "Cancel"]
                        .includes(item.textContent?.trim() ?? ""));
                if (anchor) {
                    const newItem = anchor.cloneNode(false) as HTMLElement;
                    newItem.classList.add("moveLogoAdded");
                    newItem.textContent = "Move/Resize Logo";
                    newItem.onclick = () => {
                        beginEditing();
                        closeContextMenu(gameMenu);
                    };
                    if (anchor.textContent?.trim() === "Adjust Hero Position...") {
                        anchor.insertAdjacentElement("afterend", newItem);
                    } else {
                        gameMenu.insertBefore(newItem, anchor);
                    }
                }
            }
        }
        if (isBigPicture) {
            return;
        }
        nativeMenuItems.forEach((nativeItem) => {
            const container = nativeItem.parentElement;
            const itemText = nativeItem.textContent?.trim() ?? "";
            if (resetLogoTexts.has(itemText) && !nativeItem.classList.contains("resetLogoAdded")) {
                if (nativeItem.dataset.artworkPositionerResetBound !== "true") {
                    nativeItem.dataset.artworkPositionerResetBound = "true";
                    nativeItem.addEventListener("click", relinquishCurrentPosition, { capture: true });
                }
            } else if (artworkChangeTexts.has(itemText)) {
                if (nativeItem.dataset.artworkPositionerChangeBound !== "true") {
                    nativeItem.dataset.artworkPositionerChangeBound = "true";
                    nativeItem.addEventListener("click", () => {
                        if (runtimeState.kind === "plugin") {
                            stopEditing(true);
                        } else if (runtimeState.kind === "steam") {
                            finishSteamAdjustment();
                        }
                    }, { capture: true });
                }
            }
            if (!container || !adjustLogoTexts.has(itemText)) {
                return;
            }
            let moveItem = container.querySelector<HTMLElement>(":scope > .moveLogoAdded");
            if (!moveItem) {
                moveItem = nativeItem.cloneNode(false) as HTMLElement;
                moveItem.classList.add("moveLogoAdded");
                moveItem.textContent = "Move/Resize Logo";
                moveItem.onclick = () => {
                    beginEditing();
                    closeContextMenu(container);
                };
                nativeItem.insertAdjacentElement("afterend", moveItem);
            }

            const directItems = Array.from(container.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'));
            const nativeResetItem = directItems.find((item) =>
                resetLogoTexts.has(item.textContent?.trim() ?? "")
                && !item.classList.contains("resetLogoAdded")
            );
            let fallbackResetItem = container.querySelector<HTMLElement>(":scope > .resetLogoAdded");
            const appId = readCurrentAppId();
            const hasStoredPosition = appId !== null && posDB[getPositionKey(appId)] !== undefined;

            if (nativeResetItem || !hasStoredPosition) {
                fallbackResetItem?.remove();
                return;
            }
            if (!fallbackResetItem) {
                fallbackResetItem = nativeItem.cloneNode(false) as HTMLElement;
                fallbackResetItem.classList.add("resetLogoAdded");
                fallbackResetItem.textContent = "Reset Logo Position";
                fallbackResetItem.onclick = () => {
                    relinquishCurrentPosition();
                    closeContextMenu(container);
                };
                moveItem.insertAdjacentElement("afterend", fallbackResetItem);
            }
        });
    };

    const reconcile = () => {
        reconcileQueued = false;
        try {
            const elements = findCurrentLogoElements();
            if (!elements) {
                if (runtimeState.kind === "plugin") {
                    saveEditDraft();
                } else if (runtimeState.kind === "steam") {
                    finishSteamAdjustment();
                }
                runtimeState = { kind: "idle" };
                detachDragHandler?.();
                detachDragHandler = null;
                detachResizeHandlers?.();
                detachResizeHandlers = null;
                activeElements = null;
                observedLogo = null;
                logoStyleObserver.disconnect();
                logoResizeObserver.disconnect();
                ensureMoveButton();
                enhanceContextMenus();
                return;
            }

            const previousElements = activeElements;
            const elementChanged = activeElements?.logo !== elements.logo
                || activeElements?.topCapsule !== elements.topCapsule
                || activeElements?.appId !== elements.appId;
            const appChanged = previousElements !== null && previousElements.appId !== elements.appId;
            if (appChanged) {
                if (runtimeState.kind === "plugin") {
                    saveEditDraft();
                } else if (runtimeState.kind === "steam") {
                    finishSteamAdjustment();
                }
                runtimeState = { kind: "idle" };
            }
            activeElements = elements;
            if (observedLogo !== elements.logo) {
                observedLogo = elements.logo;
                logoStyleObserver.disconnect();
                logoStyleObserver.observe(elements.logo, {
                    attributes: true,
                    attributeFilter: ["style", "class"],
                });
                logoResizeObserver.disconnect();
                logoResizeObserver.observe(elements.logo);
            }

            const steamAdjustmentVisible = isSteamAdjustmentVisible(elements);
            if (steamAdjustmentVisible) {
                if (runtimeState.kind === "plugin") {
                    saveEditDraft();
                    runtimeState = { kind: "idle" };
                }
                updateSteamAdjustment(elements);
                detachDragHandler?.();
                detachDragHandler = null;
                detachResizeHandlers?.();
                detachResizeHandlers = null;
                hideDoneButtons();
            } else {
                if (runtimeState.kind === "steam") {
                    finishSteamAdjustment();
                }
                if (runtimeState.kind === "plugin" && runtimeState.appId === elements.appId) {
                    if (elementChanged) {
                        writePercentPosition(elements, runtimeState.draft);
                        attachDragHandler(elements);
                        attachResizeHandles(elements);
                    }
                    ensureDoneButton(elements);
                } else {
                    detachDragHandler?.();
                    detachDragHandler = null;
                    detachResizeHandlers?.();
                    detachResizeHandlers = null;
                    const firstApply = elements.logo.dataset.logoposAppliedAppId !== elements.appId.toString();
                    applyStoredPosition(elements, firstApply);
                    hideDoneButtons();
                }
            }
            ensureMoveButton();
            enhanceContextMenus();
        } catch (error) {
            console.error("[steam-logo-pos] Failed to reconcile the current game page", error);
        }
    };

    function queueReconcile() {
        if (reconcileQueued) {
            return;
        }
        reconcileQueued = true;
        popupWindow.queueMicrotask(reconcile);
    }

    const logoStyleObserver = new MutationObserver(queueReconcile);
    const LogoResizeObserver = (popupWindow as any).ResizeObserver ?? ResizeObserver;
    const logoResizeObserver = new LogoResizeObserver(queueReconcile);
    const unsubscribeDocument = subscribeToDocument(popupDocument, queueReconcile);
    const onContextMenu = () => {
        popupDocument.querySelectorAll<HTMLElement>('[data-logo-positioner-hidden="true"]').forEach((menuPopup) => {
            delete menuPopup.dataset.logoPositionerHidden;
            menuPopup.style.removeProperty("display");
        });
    };
    popupDocument.addEventListener("contextmenu", onContextMenu, true);
    refreshControllers.add(queueReconcile);
    const dispose = () => {
        if (runtimeState.kind === "plugin") {
            saveEditDraft();
        } else if (runtimeState.kind === "steam") {
            finishSteamAdjustment();
        }
        detachDragHandler?.();
        detachResizeHandlers?.();
        logoStyleObserver.disconnect();
        logoResizeObserver.disconnect();
        unsubscribeDocument();
        popupDocument.removeEventListener("contextmenu", onContextMenu, true);
        refreshControllers.delete(queueReconcile);
        popupDocument.querySelectorAll(".logo-move-button, .moveLogoAdded, .resetLogoAdded, .logo-move-done-button")
            .forEach((node) => node.remove());
        if (disposeControllers.get(popupDocument) === dispose) {
            disposeControllers.delete(popupDocument);
        }
    };
    disposeControllers.set(popupDocument, dispose);
    queueReconcile();
    console.log(`[artwork-positioner] ${isBigPicture ? "Big Picture" : "Desktop"} logo controller ready`);
}

export function stopLogoModule() {
    Array.from(disposeControllers.values()).forEach((dispose) => dispose());
    disposeControllers.clear();
}

type BoolKeys = {
    [K in keyof PluginConfig]: PluginConfig[K] extends boolean ? K : never
  }[keyof PluginConfig];

type StringKeys = {
    [K in keyof PluginConfig]: PluginConfig[K] extends string ? K : never
}[keyof PluginConfig];

type SingleSettingProps =
  | { type: "bool"; name: BoolKeys; label: string; description: string }
  | { type: "text"; name: StringKeys; label: string; description: string };

const SingleSetting = (props: SingleSettingProps) => {
    const [boolValue, setBoolValue] = useState(false);

    const saveConfig = () => {
        localStorage.setItem(LOGO_CONFIG_KEY, JSON.stringify(pluginConfig));
        scheduleLogoDataSave();
    };

    useEffect(() => {
        if (props.type === "bool") {
            setBoolValue(pluginConfig[props.name]);
        }
    }, []);

    if (props.type === "bool") {
        return (
            <Field label={props.label} description={props.description} bottomSeparator="standard" focusable>
                <Toggle value={boolValue} onChange={(value) => {
                    setBoolValue(value);
                    pluginConfig[props.name] = value;
                    saveConfig();
                    refreshControllers.forEach((refresh) => refresh());
                }} />
            </Field>
        );
    } else if (props.type === "text") {
        return (
            <Field label={props.label} description={props.description} bottomSeparator="standard" focusable>
                <TextField defaultValue={pluginConfig[props.name]} onChange={(e: React.ChangeEvent<HTMLInputElement>) => { (pluginConfig as any)[props.name] = e.currentTarget.value; saveConfig(); }} />
            </Field>
        );
    } else {
        return (
            <div>This should not happen...</div>
        );
    }
}

export const LogoSettingsContent = () => {
    return (
        <div>
            <SingleSetting name="context_menu" type="bool" label="Context menu option" description="Add Move/Resize Logo to the game context menu" />
            <SingleSetting name="show_button" type="bool" label="Show button" description="Add ML button to application page" />
            <DialogButton onClick={async (e) => {
                console.log("[steam-logo-pos] Importing database");

                const openTag = (e.target as HTMLElement).ownerDocument.createElement("input");
                openTag.type = "file";
                openTag.accept = "text/plain";
                openTag.onchange = (e) => {
                    console.log("[steam-logo-pos] File selected!");

                    const reader = new FileReader();
                    reader.onload = function() {
                        const fileText = reader.result;
                        if (fileText !== null) {
                            posDB = parseStoredObject<PosDB>(fileText as string, posDB);
                            savePositionDatabase();
                            refreshControllers.forEach((refresh) => refresh());
                        }

                        (e.target as HTMLElement).remove();
                    };
                    reader.readAsText((e.target as HTMLInputElement)!.files![0]);
                };

                (e.target as HTMLElement).parentElement!.appendChild(openTag);
                openTag.click();
            }}>Import database</DialogButton>
            <DialogButton onClick={async () => {
                console.log("[steam-logo-pos] Exporting database");
                const exportText = "data:text/plain;base64," + btoa(JSON.stringify(posDB));
                SteamClient.Browser.StartDownload(exportText);
            }}>Export database</DialogButton>
        </div>
    );
};

export async function initializeLogoModule() {
    const rawValue = localStorage.getItem(LOGO_CONFIG_KEY)
        ?? localStorage.getItem(LEGACY_LOGO_CONFIG_KEY);
    const storedConfig = parseStoredObject<Partial<PluginConfig>>(rawValue, {});

    const rawDBValue = localStorage.getItem(LOGO_DATABASE_KEY)
        ?? localStorage.getItem(LEGACY_LOGO_DATABASE_KEY);
    const storedDB = parseStoredObject<PosDB>(rawDBValue, {});

    let backendData: PersistedLogoData = { version: 1, config: {}, positions: {} };
    try {
        const response = await getLogoData();
        if (typeof response === "string") {
            const parsed = parseStoredObject<Partial<PersistedLogoData>>(response, {});
            backendData = {
                version: 1,
                config: parseStoredObject<Partial<PluginConfig>>(JSON.stringify(parsed.config ?? {}), {}),
                positions: parseStoredObject<PosDB>(JSON.stringify(parsed.positions ?? {}), {}),
            };
        }
    } catch (error) {
        console.warn("[artwork-positioner] Could not load Logo data from disk", error);
    }

    // Browser storage is a migration/fallback source. Once a record is on disk,
    // the disk copy wins so a stale Steam web context cannot roll it backward.
    pluginConfig = { ...pluginConfig, ...storedConfig, ...backendData.config };
    posDB = { ...posDB, ...storedDB, ...backendData.positions };
    localStorage.setItem(LOGO_CONFIG_KEY, JSON.stringify(pluginConfig));
    savePositionDatabase();
    console.log("[artwork-positioner] Logo settings and positions loaded");
}
