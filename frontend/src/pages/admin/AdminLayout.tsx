import { useEffect, useState } from "react";
import { Outlet, Link, useNavigate, useLocation } from "react-router-dom";
import { Flex, Text, Button, IconButton } from "@radix-ui/themes";
import { LogOut, Menu, X, Home, Github, Palette, Sun, Moon, Laptop } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useDisplayTheme } from "../../contexts/DisplayThemeContext";
import { normalizeDisplayTheme } from "../../utils/displayTheme";
import { CF_MONITOR_GITHUB_URL } from "../../utils/projectLinks";
import { formatAppVersion } from "../../utils/version";
import {
  adminMenuItems,
  isAdminMenuPathActive,
} from "./adminMenu";

export default function AdminLayout() {
  const { isAuthenticated, authLoading, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { displayTheme, setDisplayTheme, toggleDisplayTheme } = useDisplayTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const githubUrl = CF_MONITOR_GITHUB_URL;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [version, setVersion] = useState("dev");
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/login", {
        replace: true,
        state: { from: `${location.pathname}${location.search}` },
      });
    }
  }, [authLoading, isAuthenticated, location.pathname, location.search, navigate]);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((data) => {
        if (data.version) setVersion(formatAppVersion(data.version));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetch("/api/admin/update-check")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setHasUpdate(Boolean(data?.has_update)))
      .catch(() => {});
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const preloadSettings = () => {
      void import("./SettingsLayout");
      void import("./SettingsSite");
      void import("./SettingsGeneral");
    };
    const idleId = window.requestIdleCallback
      ? window.requestIdleCallback(preloadSettings)
      : window.setTimeout(preloadSettings, 0);
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
    };
  }, [isAuthenticated]);

  // responsive sidebar
  useEffect(() => {
    const handleResize = () => {
      setSidebarOpen(window.innerWidth >= 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (authLoading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: "100vh" }}>
        <Text size="2" color="gray">加载中…</Text>
      </Flex>
    );
  }

  if (!isAuthenticated) return null;

  const handleLogout = () => {
    const currentDisplayTheme = normalizeDisplayTheme(document.documentElement.getAttribute("data-monitor-theme") || displayTheme);
    setDisplayTheme(currentDisplayTheme);
    logout();
    navigate("/");
  };

  const cycleTheme = () => {
    const themes: Array<"light" | "dark" | "system"> = ["light", "dark", "system"];
    const idx = themes.indexOf(theme);
    setTheme(themes[(idx + 1) % themes.length]);
  };

  const openGithub = () => {
    if (!githubUrl) return;
    window.open(githubUrl, "_blank", "noopener,noreferrer");
  };

  const openPublicSite = () => {
    window.open("/", "_blank", "noopener,noreferrer");
  };

  const themeIcon =
    theme === "dark" ? <Moon size={18} /> : theme === "light" ? <Sun size={18} /> : <Laptop size={18} />;
  const nextDisplayTheme = displayTheme === "monitor" ? "next" : "monitor";
  const nextThemeLabel =
    theme === "light" ? "切换成深色模式" : theme === "dark" ? "切换成跟随系统" : "切换成浅色模式";

  return (
    <Flex style={{ height: "100vh", overflow: "hidden" }}>
      {/* Mobile overlay */}
      {sidebarOpen && window.innerWidth < 768 && (
        <div className="mobile-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Mobile toggle button */}
      <IconButton
        className={`mobile-sidebar-toggle${sidebarOpen ? " is-open" : ""}`}
        onClick={() => setSidebarOpen((v) => !v)}
        aria-label={sidebarOpen ? "关闭菜单" : "打开菜单"}
        title={sidebarOpen ? "关闭菜单" : "打开菜单"}
      >
        {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </IconButton>

      {/* Sidebar */}
      <aside className={`admin-sidebar ${sidebarOpen ? "open" : ""}`}>
        <Flex className="admin-sidebar-header" align="center" justify="between">
          <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
            <Text size="4" weight="bold" style={{ color: "var(--accent-11)", lineHeight: 1.15 }}>
              CF VPS Monitor
            </Text>
            <Text size="1" color="gray">管理后台</Text>
          </Flex>
          {window.innerWidth < 768 && (
            <IconButton variant="ghost" size="1" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单">
              <X size={16} />
            </IconButton>
          )}
        </Flex>

        <nav className="admin-sidebar-nav" style={{ flex: 1, overflowY: "auto" }}>
          {adminMenuItems.map((item) => {
            const active = isAdminMenuPathActive(item.path, location.pathname);

            // external link (e.g. docs)
            if (item.external) {
              return (
                <a
                  key={item.path}
                  href={item.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <Flex
                    align="center"
                    gap="3"
                    px="3"
                    py="2"
                    className="admin-menu-item"
                    style={{
                      backgroundColor: "transparent",
                      borderLeft: "3px solid transparent",
                      color: "var(--gray-11)",
                      transition: "background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease",
                      borderRadius: 8,
                      cursor: "pointer",
                      minHeight: 40,
                      margin: "3px 8px",
                    }}
                  >
                    {item.icon}
                    <Text size="2">{item.label}</Text>
                  </Flex>
                </a>
              );
            }

            return (
              <Link key={item.path} to={item.path} style={{ textDecoration: "none" }}>
                <Flex
                  align="center"
                  gap="3"
                  px="3"
                  py="2"
                  className="admin-menu-item"
                  style={{
                    backgroundColor: active ? "var(--accent-4)" : "transparent",
                    borderLeft: active ? "3px solid var(--accent-8)" : "3px solid transparent",
                    color: active ? "var(--accent-11)" : "var(--gray-11)",
                    transition: "background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease",
                    borderRadius: 8,
                    cursor: "pointer",
                    minHeight: 40,
                    margin: "3px 8px",
                  }}
                  onClick={() => {
                    if (window.innerWidth < 768) setSidebarOpen(false);
                  }}
                >
                  {item.icon}
                  <Text size="2">{item.label}</Text>
                </Flex>
              </Link>
            );
          })}
        </nav>

        <div className="admin-sidebar-footer">
          <Flex px="4" py="3" direction="column" gap="2">
            <Button className="admin-sidebar-action" variant="soft" size="2" onClick={openPublicSite} style={{ width: "100%" }}>
              <Home size={14} /> 返回前台
            </Button>
            <Button className="admin-sidebar-action" variant="soft" size="2" onClick={handleLogout} color="red" style={{ width: "100%" }}>
              <LogOut size={14} /> 退出登录
            </Button>
          </Flex>
          <Flex px="4" pb="2" justify="center">
            <Button
              variant="ghost"
              size="1"
              onClick={() => navigate("/admin/about")}
              style={{ maxWidth: "100%", padding: "2px 6px" }}
            >
              <Text size="1" color={hasUpdate ? "orange" : "gray"}>
                {version}{hasUpdate ? " · 有更新" : ""}
              </Text>
            </Button>
          </Flex>
        </div>
      </aside>

      <main className="admin-main" style={{ flex: 1, minWidth: 0, padding: "8px 16px 16px", overflowY: "auto" }}>
        <div className="admin-main-content" style={{ maxWidth: 1400, margin: "0 auto", width: "100%" }}>
          <div className="admin-top-actions" aria-label="后台快捷操作">
            <IconButton
              className="admin-top-action-button"
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
              className="admin-top-action-button"
              variant="soft"
              size="2"
              onClick={toggleDisplayTheme}
              aria-label={`切换成 ${nextDisplayTheme} 主题`}
              title={`切换成 ${nextDisplayTheme} 主题`}
            >
              <Palette size={18} />
            </IconButton>
            <IconButton
              className="admin-top-action-button"
              variant="soft"
              size="2"
              onClick={cycleTheme}
              aria-label={nextThemeLabel}
              title={nextThemeLabel}
            >
              {themeIcon}
            </IconButton>
            <IconButton
              className="admin-top-action-button"
              variant="soft"
              size="2"
              onClick={() => navigate("/")}
              aria-label="返回前台"
              title="返回前台"
            >
              <Home size={18} />
            </IconButton>
          </div>
          <Outlet />
        </div>
      </main>

      <style>{`
        .admin-sidebar {
          width: 180px;
          min-width: 180px;
          height: 100vh;
          position: sticky;
          top: 0;
          border-right: 1px solid var(--monitor-border);
          background: var(--monitor-panel);
          backdrop-filter: blur(18px) saturate(150%);
          -webkit-backdrop-filter: blur(18px) saturate(150%);
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }
        .admin-sidebar-header {
          min-height: 72px;
          padding: 16px 12px 14px;
          border-bottom: 1px solid var(--monitor-border);
        }
        .admin-sidebar-nav {
          padding: 8px 0 12px;
        }
        .admin-menu-item {
          align-items: center;
        }
        .admin-menu-item svg {
          flex-shrink: 0;
        }
        .admin-sidebar-footer {
          border-top: 1px solid var(--monitor-border);
          background: var(--monitor-panel-muted);
        }
        .admin-sidebar-action {
          min-height: 38px;
          justify-content: center;
          text-align: center;
        }
        .admin-main {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
          height: 100vh;
          background: var(--monitor-page-bg);
        }
        .admin-main-content {
          position: relative;
        }
        .admin-top-actions {
          position: absolute;
          top: 0;
          right: 0;
          z-index: 30;
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: 8px;
          min-height: 40px;
          margin: 0;
          padding: 0;
          pointer-events: none;
        }
        .admin-top-action-button {
          width: 38px !important;
          min-width: 38px !important;
          height: 38px !important;
          padding: 0 !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          border: 1px solid var(--monitor-border) !important;
          background: var(--monitor-panel-strong) !important;
          color: var(--gray-12) !important;
          box-shadow: 0 10px 24px color-mix(in srgb, var(--monitor-accent) 8%, transparent);
          pointer-events: auto;
        }
        .admin-top-action-button:hover {
          border-color: color-mix(in srgb, var(--monitor-accent) 42%, var(--monitor-border)) !important;
          background: color-mix(in srgb, var(--monitor-accent) 12%, var(--monitor-panel-strong)) !important;
        }
        .admin-top-action-button svg {
          width: 18px;
          height: 18px;
          stroke-width: 2;
        }
        .admin-menu-item:hover {
          background-color: var(--accent-2) !important;
          color: var(--accent-11) !important;
        }
        .mobile-sidebar-toggle {
          display: none;
        }
        @media (max-width: 768px) {
          .admin-sidebar {
            position: fixed !important;
            top: 0;
            left: 0;
            bottom: 0;
            width: 135px;
            min-width: 135px;
            transform: translateX(-100%);
            transition: transform 0.3s ease;
            z-index: 45;
          }
          .admin-sidebar.open {
            transform: translateX(0);
          }
          .admin-main {
            margin-left: 0 !important;
            width: 100% !important;
            padding: 12px 16px 16px !important;
          }
          .admin-main-content {
            padding-top: 46px;
          }
          .admin-top-actions {
            min-height: 40px;
            margin: 0;
            padding-left: 52px;
          }
          .admin-top-action-button {
            width: 38px !important;
            min-width: 38px !important;
            height: 38px !important;
          }
          .mobile-sidebar-toggle {
            display: flex !important;
            position: fixed;
            top: 12px;
            left: 12px;
            z-index: 50;
            border: 1px solid var(--monitor-border);
            border-radius: 10px;
            background: var(--monitor-panel-strong);
            color: var(--gray-12);
            padding: 8px;
          }
          .mobile-sidebar-toggle.is-open {
            display: none !important;
          }
          .mobile-sidebar-overlay {
            display: block !important;
            position: fixed;
            inset: 0;
            z-index: 39;
            background-color: rgba(0, 0, 0, 0.5);
          }
        }
      `}</style>
    </Flex>
  );
}
