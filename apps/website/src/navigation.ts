import { REPOSITORY } from "./site.ts"

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/"
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function navigation(pathname: string, githubStars?: number): string {
  const path = normalizedPath(pathname)
  const stars =
    githubStars === undefined
      ? undefined
      : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(githubStars)
  const primary = [
    { href: "/about", label: "/about" },
    { href: "/tools", label: "/tools" },
    { href: "/plugins", label: "/plugins" },
    { href: "/docs", label: "/docs" },
    { href: "/get", label: "/install" },
  ]
    .map(({ href, label }) => {
      const current = path === href
      return `<a class="site-link${isActive(path, href) ? " active" : ""}" href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`
    })
    .join("")

  return `<header class="site-header">
    <nav class="site-nav" aria-label="Primary navigation">
      <a class="site-brand" href="/" aria-label="xal home">xal<span class="site-brand-cursor" aria-hidden="true"></span></a>
      <div class="site-links">${primary}</div>
      <div class="site-actions">
        <a class="site-stars" href="${REPOSITORY}/stargazers" target="_blank" rel="noreferrer" aria-label="GitHub stars${stars === undefined ? "" : `: ${stars}`}">
          <svg class="site-star-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg><span class="site-stars-label">Stars</span>${stars === undefined ? "" : `<span class="site-star-count">${stars}</span>`}
        </a>
        <a class="site-github" href="${REPOSITORY}" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      </div>
    </nav>
  </header>`
}

export function setNavigationPath(pathname: string): void {
  const path = normalizedPath(pathname)
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".site-link")) {
    const href = link.getAttribute("href")
    if (!href) throw new Error("Navigation link is missing href")
    link.classList.toggle("active", isActive(path, href))
    if (path === href) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  }
}

export function installNavigation(): void {
  if (!document.querySelector(".site-header")) {
    document.body.insertAdjacentHTML("afterbegin", navigation(location.pathname))
  }
}
