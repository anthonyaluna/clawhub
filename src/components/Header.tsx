import { useAuthActions } from '@convex-dev/auth/react'
import { Link } from '@tanstack/react-router'
import { useConvexAuth, useQuery } from 'convex/react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useRef } from 'react'
import { api } from '../../convex/_generated/api'
import { gravatarUrl } from '../lib/gravatar'
import { applyTheme, useThemeMode } from '../lib/theme'
import { startThemeTransition } from '../lib/theme-transition'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

export default function Header() {
  const { isAuthenticated, isLoading } = useConvexAuth()
  const { signIn, signOut } = useAuthActions()
  const me = useQuery(api.users.me)
  const { mode, setMode } = useThemeMode()
  const toggleRef = useRef<HTMLDivElement | null>(null)

  const avatar = me?.image ?? (me?.email ? gravatarUrl(me.email) : undefined)
  const handle = me?.handle ?? me?.displayName ?? 'user'
  const initial = (me?.displayName ?? me?.name ?? handle).charAt(0).toUpperCase()

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <img src="/clawd-logo.png" alt="" aria-hidden="true" />
          </span>
          ClawdHub
        </Link>
        <nav className="nav-links">
          <Link to="/skills">Skills</Link>
          <Link to="/upload">Upload</Link>
          <Link to="/search">Search</Link>
          {me ? <Link to="/stars">Stars</Link> : null}
          {me?.role === 'admin' || me?.role === 'moderator' ? <Link to="/admin">Admin</Link> : null}
        </nav>
        <div className="nav-actions">
          <ToggleGroup
            ref={toggleRef}
            type="single"
            value={mode}
            onValueChange={(value) => {
              if (!value) return
              startThemeTransition({
                nextTheme: value as 'system' | 'light' | 'dark',
                currentTheme: mode,
                setTheme: (next) => {
                  const nextMode = next as 'system' | 'light' | 'dark'
                  applyTheme(nextMode)
                  setMode(nextMode)
                },
                context: { element: toggleRef.current },
              })
            }}
            aria-label="Theme mode"
          >
            <ToggleGroupItem value="system" aria-label="System theme">
              <Monitor className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">System</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="light" aria-label="Light theme">
              <Sun className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Light</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Dark theme">
              <Moon className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Dark</span>
            </ToggleGroupItem>
          </ToggleGroup>
          {isAuthenticated && me ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="user-trigger" type="button">
                  {avatar ? (
                    <img src={avatar} alt={me.displayName ?? me.name ?? 'User avatar'} />
                  ) : (
                    <span className="user-menu-fallback">{initial}</span>
                  )}
                  <span className="mono">@{handle}</span>
                  <span className="user-menu-chevron">▾</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/settings">Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={isLoading}
              onClick={() => void signIn('github')}
            >
              Sign in with GitHub
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
