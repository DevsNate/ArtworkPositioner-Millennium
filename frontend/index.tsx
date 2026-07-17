import { definePlugin, IconsModule, Millennium } from '@steambrew/client';
import { attachLogoToPopup, initializeLogoModule, LogoSettingsContent, stopLogoModule } from './logo';
import {
  attachHeroToPopup,
  HeroPositionContent,
  initializeHeroModule,
  stopHeroModule,
} from './hero';
import { disposeDocumentRuntimes } from './window-runtime';

const ArtworkPositionerSettings = () => (
  <div>
    <LogoSettingsContent />
    <HeroPositionContent />
  </div>
);

export default definePlugin(async () => {
  console.log('[artwork-positioner] Frontend startup');
  await initializeLogoModule();
  initializeHeroModule();

  const hookWindow = window as Window & {
    __ARTWORK_POSITIONER_WINDOW_HOOK__?: (popup: any) => void;
    __ARTWORK_POSITIONER_WINDOW_HOOK_REGISTERED__?: boolean;
  };
  hookWindow.__ARTWORK_POSITIONER_WINDOW_HOOK__ = (popup) => {
    attachHeroToPopup(popup);
    void attachLogoToPopup(popup);
  };
  if (!hookWindow.__ARTWORK_POSITIONER_WINDOW_HOOK_REGISTERED__ && Millennium.AddWindowCreateHook) {
    Millennium.AddWindowCreateHook((popup) => hookWindow.__ARTWORK_POSITIONER_WINDOW_HOOK__?.(popup));
    hookWindow.__ARTWORK_POSITIONER_WINDOW_HOOK_REGISTERED__ = true;
  }

  return {
    title: 'Artwork Positioner',
    icon: <IconsModule.Image />,
    content: <ArtworkPositionerSettings />,
    onDismount() {
      hookWindow.__ARTWORK_POSITIONER_WINDOW_HOOK__ = undefined;
      stopLogoModule();
      stopHeroModule();
      disposeDocumentRuntimes();
    },
  };
});
