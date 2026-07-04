/**
 * OS Image & Icon Helper
 * Maps OS strings to both image paths (for <img>) and emoji fallback.
 * OS icon helper with emoji fallback.
 */

export interface OSConfig {
  name: string;
  image: string;
  icon: string;
  keywords: string[];
}

const osConfigs: OSConfig[] = [
  { name: 'AlmaLinux', image: '/assets/logo/os-alma.svg', icon: '💠', keywords: ['alma', 'almalinux'] },
  { name: 'Alpine Linux', image: '/assets/logo/os-alpine.webp', icon: '🏔️', keywords: ['alpine', 'alpine linux'] },
  { name: 'Armbian', image: '/assets/logo/os-armbian.svg', icon: '🔧', keywords: ['armbian'] },
  { name: 'CentOS', image: '/assets/logo/os-centos.svg', icon: '🔒', keywords: ['centos', 'cent os'] },
  { name: 'Debian', image: '/assets/logo/os-debian.svg', icon: '🌀', keywords: ['debian', 'deb'] },
  { name: 'FreeBSD', image: '/assets/logo/os-freebsd.svg', icon: '😈', keywords: ['freebsd', 'bsd'] },
  { name: 'Ubuntu', image: '/assets/logo/os-ubuntu.svg', icon: '🐧', keywords: ['ubuntu', 'elementary'] },
  { name: 'Windows', image: '/assets/logo/os-windows.svg', icon: '🪟', keywords: ['windows', 'win', 'microsoft', 'ms'] },
  { name: 'Arch Linux', image: '/assets/logo/os-arch.svg', icon: '🔷', keywords: ['arch', 'archlinux', 'arch linux'] },
  { name: 'Kali Linux', image: '/assets/logo/os-kail.svg', icon: '🐉', keywords: ['kail', 'kali', 'kali linux'] },
  { name: 'iStoreOS', image: '/assets/logo/os-istore.png', icon: '📦', keywords: ['istore', 'istoreos', 'istore os'] },
  { name: 'OpenWrt', image: '/assets/logo/os-openwrt.svg', icon: '📡', keywords: ['openwrt', 'open wrt', 'open-wrt', 'qwrt'] },
  { name: 'ImmortalWrt', image: '/assets/logo/os-openwrt.svg', icon: '📡', keywords: ['immortalwrt', 'immortal', 'emmortal'] },
  { name: 'NixOS', image: '/assets/logo/os-nix.svg', icon: '❄️', keywords: ['nixos', 'nix os', 'nix'] },
  { name: 'Rocky Linux', image: '/assets/logo/os-rocky.svg', icon: '🪨', keywords: ['rocky', 'rocky linux'] },
  { name: 'Fedora', image: '/assets/logo/os-fedora.svg', icon: '🎩', keywords: ['fedora'] },
  { name: 'openSUSE', image: '/assets/logo/os-openSUSE.svg', icon: '🦎', keywords: ['opensuse', 'suse'] },
  { name: 'Gentoo', image: '/assets/logo/os-gentoo.svg', icon: '💜', keywords: ['gentoo'] },
  { name: 'Red Hat', image: '/assets/logo/os-redhat.svg', icon: '🎩', keywords: ['redhat', 'rhel', 'red hat'] },
  { name: 'Linux Mint', image: '/assets/logo/os-mint.svg', icon: '🍃', keywords: ['mint', 'linux mint'] },
  { name: 'Manjaro', image: '/assets/logo/os-manjaro-.svg', icon: '🟢', keywords: ['manjaro'] },
  { name: 'Synology DSM', image: '/assets/logo/os-synology.ico', icon: '💾', keywords: ['synology', 'dsm', 'synology dsm'] },
  { name: 'fnOS', image: '/assets/logo/os-fnos.ico', icon: '🏠', keywords: ['fnos', 'fnnas'] },
  { name: 'Proxmox VE', image: '/assets/logo/os-proxmox.ico', icon: '🖥️', keywords: ['proxmox', 'proxmox ve'] },
  { name: 'macOS', image: '/assets/logo/os-macos.svg', icon: '🍎', keywords: ['macos', 'mac os', 'darwin'] },
  { name: 'QTS', image: '/assets/logo/os-qnap.svg', icon: '💾', keywords: ['qts', 'quts hero', 'qes', 'qutscloud'] },
  { name: 'Astra Linux', image: '/assets/logo/os-astar.png', icon: '🌟', keywords: ['astra', 'astra linux'] },
  { name: 'Orange Pi', image: '/assets/logo/os-orange-pi.svg', icon: '🍊', keywords: ['orange pi', 'orangepi'] },
  { name: 'Huawei', image: '/assets/logo/os-huawei.svg', icon: '🔴', keywords: ['huawei', 'euleros', 'euler os'] },
  { name: 'Aliyun', image: '/assets/logo/alibabacloud-color.svg', icon: '☁️', keywords: ['aliyun', 'alibaba'] },
  { name: 'OpenCloudOS', image: '/assets/logo/os-OpenCloudOS.png', icon: '☁️', keywords: ['opencloud'] },
  { name: 'Unraid', image: '/assets/logo/os-unraid.svg', icon: '📀', keywords: ['unraid'] },
  { name: 'Docker', image: '/assets/logo/linux.svg', icon: '🐳', keywords: ['docker'] },
  { name: 'Container', image: '/assets/logo/linux.svg', icon: '📦', keywords: ['container', 'lxc', 'containerd'] },
  { name: 'Android', image: '/assets/logo/linux.svg', icon: '🤖', keywords: ['android'] },
];

const defaultConfig: OSConfig = { name: 'Linux', image: '/assets/logo/linux.svg', icon: '🐧', keywords: ['linux'] };

function findOS(osString: string): OSConfig {
  if (!osString) return defaultConfig;
  const normalized = osString.toLowerCase().trim();
  for (const config of osConfigs) {
    for (const keyword of config.keywords) {
      if (normalized.includes(keyword)) return config;
    }
  }
  // fallback: if string contains "linux" at all
  if (normalized.includes('linux')) return defaultConfig;
  return { name: 'Unknown', image: '/assets/logo/linux.svg', icon: '🖥️', keywords: [] };
}

/** Get OS image path for <img src=""> usage */
export function getOSImage(osString: string): string {
  return findOS(osString).image;
}

/** Get emoji icon for inline display */
export function getOSIcon(osString: string): string {
  return findOS(osString).icon;
}

/** Get friendly OS name */
export function getOSName(osString: string): string {
  if (!osString?.trim()) return '-';
  const config = findOS(osString);
  if (config.name !== 'Unknown') return config.name;
  return osString.trim().split(/[\s/]/)[0] || '-';
}

/** Get both icon and name */
export function getOSDisplay(osString: string): { icon: string; name: string; image: string } {
  if (!osString?.trim()) {
    return { icon: defaultConfig.icon, name: '-', image: defaultConfig.image };
  }
  const config = findOS(osString);
  return {
    icon: config.icon,
    name: config.name !== 'Unknown' ? config.name : (osString?.trim().split(/[\s/]/)[0] || '-'),
    image: config.image,
  };
}
