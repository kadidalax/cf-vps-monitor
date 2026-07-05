import { useEffect, useState } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { Text, IconButton, SegmentedControl } from "@radix-ui/themes";
import { Settings, Sun, Moon, Laptop, Palette, Github } from "lucide-react";

import { useTheme } from "../contexts/ThemeContext";
import { hasLocalDisplayThemePreference, useDisplayTheme } from "../contexts/DisplayThemeContext";
import { normalizeDisplayTheme } from "../utils/displayTheme";
import { CF_MONITOR_GITHUB_URL } from "../utils/projectLinks";
import { fetchPublicSettings } from "../utils/publicSettings";
import { subscribePublicDataUpdated } from "../utils/publicDataEvents";
import { subscribeThemeUpdated } from "../utils/themeEvents";
import { refreshActiveThemeStylesheet } from "../utils/activeThemeStylesheet";

function safeBackgroundUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("/")) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && window.location.protocol === "http:") return url.toString();
  } catch {
    return "";
  }
  return "";
}

function safeLogoUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin === window.location.origin || url.protocol === "https:") return url.toString();
  } catch {
    return "";
  }
  return "";
}

export default function Layout() {
  const { theme, setTheme } = useTheme();
  const { displayTheme, setDisplayThemeFromSettings, toggleDisplayTheme } = useDisplayTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const githubUrl = CF_MONITOR_GITHUB_URL;
  const [siteTitle, setSiteTitle] = useState("CF VPS Monitor");
  const [siteSubtitle, setSiteSubtitle] = useState<string | null>(null);
  const [siteLogoUrl, setSiteLogoUrl] = useState("");
  const [bgUrlDesktop, setBgUrlDesktop] = useState("");
  const [bgUrlMobile, setBgUrlMobile] = useState("");
  const [mainContentWidth, setMainContentWidth] = useState(100);

  useEffect(() => {
    const applyPublicSettings = () => {
      refreshActiveThemeStylesheet();
      fetchPublicSettings({ force: true })
      .then((data) => {
        if (data.site_title) {
          setSiteTitle(data.site_title);
          document.title = data.site_title;
        }
        if (typeof data.site_subtitle === "string" && data.site_subtitle.trim()) {
          setSiteSubtitle(data.site_subtitle);
        }
        setSiteLogoUrl(safeLogoUrl(data.site_logo_url));
        if (data.theme_settings?.backgroundImageUrlDesktop)
          setBgUrlDesktop(safeBackgroundUrl(data.theme_settings.backgroundImageUrlDesktop));
        if (data.theme_settings?.backgroundImageUrlMobile)
          setBgUrlMobile(safeBackgroundUrl(data.theme_settings.backgroundImageUrlMobile));
        if (data.theme_settings?.mainContentWidth)
          setMainContentWidth(data.theme_settings.mainContentWidth);
        if (!hasLocalDisplayThemePreference()) {
          setDisplayThemeFromSettings(normalizeDisplayTheme(data.active_theme));
        }
      })
      .catch(() => {});
    };

    applyPublicSettings();
    const unsubscribeTheme = subscribeThemeUpdated(applyPublicSettings);
    const unsubscribePublicData = subscribePublicDataUpdated(applyPublicSettings);
    return () => {
      unsubscribeTheme();
      unsubscribePublicData();
    };
  }, [setDisplayThemeFromSettings]);

  const cycleTheme = () => {
    const themes: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];
    const idx = themes.indexOf(theme);
    setTheme(themes[(idx + 1) % themes.length]);
  };

  const enterBackend = () => {
    navigate("/admin");
  };

  const openGithub = () => {
    if (!githubUrl) return;
    window.open(githubUrl, "_blank", "noopener,noreferrer");
  };

  const themeIcon =
    theme === "dark" ? <Moon size={18} /> : theme === "light" ? <Sun size={18} /> : <Laptop size={18} />;
  const nextDisplayTheme = displayTheme === "monitor" ? "next" : "monitor";
  const nextThemeLabel =
    theme === "light" ? "切换成深色模式" : theme === "dark" ? "切换成跟随系统" : "切换成浅色模式";
  const bgUrl = bgUrlDesktop || bgUrlMobile;
  const contentWidth = mainContentWidth >= 100 ? "100%" : `${mainContentWidth}vw`;
  const monitorMode = new URLSearchParams(location.search).get("view") === "websites" ? "websites" : "servers";
  const setMonitorMode = (value: string) => {
    const params = new URLSearchParams(location.search);
    if (value === "websites") params.set("view", "websites");
    else params.delete("view");
    navigate({ pathname: "/", search: params.toString() ? `?${params}` : "" });
  };

  return (
    <div
      className={bgUrl ? "layout bg-cover bg-center bg-fixed bg-no-repeat" : "layout"}
      style={{ backgroundImage: bgUrl ? `url(${JSON.stringify(bgUrl)})` : "none", backgroundColor: bgUrl ? "transparent" : "var(--accent-1)" }}
    >
      <main
        className="main-content h-full"
        style={{ width: contentWidth, maxWidth: "100%", marginLeft: "auto", marginRight: "auto" }}
      >
        <nav className="nav-bar">
          <div className="nav-brand">
            <Link to="/" className="nav-brand-link">
              <span className="nav-logo-mark" aria-hidden="true">
                <img src={siteLogoUrl || "/app-icon.png"} alt="" />
              </span>
              <span className="nav-brand-title">{siteTitle}</span>
            </Link>
            {siteSubtitle && (
              <div className="nav-brand-subtitle">
                <div className="nav-brand-divider" />
                <span>{siteSubtitle}</span>
              </div>
            )}
            {location.pathname === "/" && (
              <SegmentedControl.Root className="nav-monitor-switch" value={monitorMode} onValueChange={setMonitorMode} size="2">
                <SegmentedControl.Item value="servers">服务器监控</SegmentedControl.Item>
                <SegmentedControl.Item value="websites">网站监控</SegmentedControl.Item>
              </SegmentedControl.Root>
            )}
          </div>

          <div className="nav-actions">
            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={openGithub}
              aria-label={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
              aria-disabled={!githubUrl}
              title={githubUrl ? "打开 GitHub" : "GitHub 链接待添加"}
            >
              <Github size={18} />
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={toggleDisplayTheme}
              aria-label={`切换成 ${nextDisplayTheme} 主题`}
              title={`切换成 ${nextDisplayTheme} 主题`}
            >
              <Palette size={18} />
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={cycleTheme}
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
            >
              {themeIcon}
            </IconButton>

            <IconButton
              className="nav-icon-button"
              variant="soft"
              size="2"
              onClick={enterBackend}
              aria-label="进入后台"
              title="进入后台"
            >
              <Settings size={18} />
            </IconButton>
          </div>
        </nav>

        <Outlet />
      </main>

      <footer className="footer">
        <Text size="2" color="gray" className="footer-powered">
          <span>Powered by</span>
          <a href={githubUrl} target="_blank" rel="noreferrer" aria-label="GitHub">
            <Github size={16} />
          </a>
        </Text>
      </footer>
    </div>
  );
}
