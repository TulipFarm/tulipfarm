import {
  type LinkProps,
  type NavLinkProps,
  Link as RouterLink,
  NavLink as RouterNavLink,
} from "@remix-run/react";
import { forwardRef } from "react";

/*
 * `Link` and `NavLink`, prefetching on intent by default.
 *
 * This app runs Remix with `ssr: false`, so a route's `clientLoader` lives inside its route module:
 * a click cannot begin fetching data until the module chain has been discovered and downloaded,
 * which measured as three serial waves and a 1.35s gap before the first API call. Prefetching on
 * hover or focus moves that work ahead of the click, and in SPA mode it costs no extra API request
 * — Remix only emits `modulepreload` tags for routes whose loader is a `clientLoader`.
 *
 * The default lives here rather than at each call site because a link that forgets it is
 * indistinguishable, to the person clicking, from an app that is simply slow. Pass `prefetch`
 * explicitly to override.
 */

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(props, ref) {
  return <RouterLink prefetch="intent" ref={ref} {...props} />;
});

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(props, ref) {
  return <RouterNavLink prefetch="intent" ref={ref} {...props} />;
});
