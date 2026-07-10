import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import './index.css';
import App from './App';
import MfaStepUpDialog from './components/MfaStepUpDialog';
import { getLocalStorageItem } from './utils/browserStorage';
import { getExplicitThemeAppearance, normalizeThemeMode } from './utils/themeAppearance';
import type { ThemeMode } from './utils/themeAppearance';
import { DisplayTheme, normalizeDisplayTheme } from './utils/displayTheme';

function accentColorForDisplayTheme(theme: DisplayTheme): 'cyan' | 'violet' {
  return theme === 'next' ? 'cyan' : 'violet';
}

// 初始化主题：在 React 渲染前从 localStorage 读取
const savedTheme = normalizeThemeMode(getLocalStorageItem('cf-monitor-theme'));
const initialAppearance = getExplicitThemeAppearance(savedTheme);
if (initialAppearance) {
  document.documentElement.setAttribute('data-theme-appearance', initialAppearance);
} else {
  document.documentElement.removeAttribute('data-theme-appearance');
}

const savedDisplayTheme = getLocalStorageItem('cf-monitor-display-theme');
document.documentElement.setAttribute(
  'data-monitor-theme',
  normalizeDisplayTheme(savedDisplayTheme),
);

const Root = () => {
  const [appearance, setAppearance] = React.useState<'light' | 'dark' | undefined>(
    () => initialAppearance,
  );
  const [accentColor, setAccentColor] = React.useState<'cyan' | 'violet'>(
    () => accentColorForDisplayTheme(normalizeDisplayTheme(savedDisplayTheme)),
  );

  // 暴露 setter 给全局
  React.useEffect(() => {
    (window as any).__setThemeAppearance = (theme: ThemeMode) => {
      const explicitAppearance = getExplicitThemeAppearance(theme);
      if (!explicitAppearance) {
        document.documentElement.removeAttribute('data-theme-appearance');
      } else {
        document.documentElement.setAttribute('data-theme-appearance', explicitAppearance);
      }
      setAppearance(explicitAppearance);
    };
    (window as any).__setRadixAccentColor = (theme: DisplayTheme) => {
      setAccentColor(accentColorForDisplayTheme(theme));
    };
  }, []);

  return (
    <React.StrictMode>
      <BrowserRouter>
        <Theme
          accentColor={accentColor}
          grayColor="slate"
          scaling="100%"
          radius="medium"
          appearance={appearance}
          panelBackground="translucent"
        >
          <App />
          <MfaStepUpDialog />
        </Theme>
      </BrowserRouter>
    </React.StrictMode>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(<Root />);
