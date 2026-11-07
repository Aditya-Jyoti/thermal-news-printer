import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

export interface BrowserColors {
  toolbar?: string;
  controls?: string;
}

/** Opens the original article in an in-app Chrome Custom Tab (falls back to the system browser). */
export async function openArticle(url: string | null | undefined, colors: BrowserColors = {}): Promise<void> {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    await WebBrowser.openBrowserAsync(url, {
      toolbarColor: colors.toolbar,
      controlsColor: colors.controls,
      enableBarCollapsing: true,
      showTitle: true,
    });
  } catch {
    await Linking.openURL(url).catch(() => undefined);
  }
}
