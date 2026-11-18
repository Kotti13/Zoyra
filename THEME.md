ZOYRA - DARK THEME DESIGN SYSTEM
==================================

===============================================================================
COLOR PALETTE
===============================================================================

BACKGROUNDS
-----------
Primary Background:     #0A0A0F    (near-black with blue undertone)
Secondary Background:   #12121A    (cards, elevated surfaces)
Tertiary Background:    #1A1A2E    (input fields, search bar)
Surface:                #16213E    (bottom sheets, modals)
Surface Elevated:       #1E2A4A    (floating elements, FAB)

ACCENT / BRAND
--------------
Primary Accent:         #6C5CE7    (Zoyra purple - buttons, highlights)
Primary Light:          #A29BFE    (hover states, secondary text links)
Primary Dark:           #4834D4    (pressed states)
Gradient Start:         #6C5CE7    (purple)
Gradient End:           #00CEC9    (teal)
Brand Gradient:         linear(135deg, #6C5CE7, #00CEC9)

TEXT
----
Text Primary:           #EAEAEA    (titles, body text)
Text Secondary:         #8B8B9E    (subtitles, metadata)
Text Tertiary:          #55556B    (placeholders, disabled)
Text On Accent:         #FFFFFF    (text on purple buttons)
Text Link:              #A29BFE    (tappable text)

PLAYER
------
Player Background:      #0D0D14    (full-screen player bg)
Seek Bar Track:         #2A2A3E    (inactive seek bar)
Seek Bar Active:        #6C5CE7    (played portion)
Seek Bar Thumb:         #FFFFFF    (draggable dot)
Mini Player BG:         #16162A    (mini player bar)
Mini Player Border:     #2A2A3E    (top border)

STATUS
------
Success:                #00B894    (download complete, online)
Warning:                #FDCB6E    (low storage, weak signal)
Error:                  #FF6B6B    (failed, offline)
Info:                   #74B9FF    (tips, info banners)
Live:                   #FF6B6B    (live indicator dot)

SOCIAL
------
Like/Heart:             #FF6B81    (liked songs, heart button)
Shuffle Active:         #00CEC9    (teal when active)
Repeat Active:          #00CEC9    (teal when active)

OVERLAYS
--------
Overlay Dark:           rgba(0, 0, 0, 0.7)     (modal backdrop)
Overlay Light:          rgba(255, 255, 255, 0.05) (glassmorphism)
Glass Background:       rgba(22, 22, 42, 0.8)  (glassmorphism cards)
Glass Border:           rgba(255, 255, 255, 0.08)

===============================================================================
TYPOGRAPHY
===============================================================================

Font Family:            'Inter' (primary), 'SF Pro Display' (iOS fallback)
Mono Font:              'JetBrains Mono' (timestamps, durations)

Sizes:
  Hero Title:           32px  / Bold    / -0.5 tracking
  Screen Title:         24px  / Bold    / -0.3 tracking
  Section Header:       18px  / SemiBold / 0 tracking
  Body:                 16px  / Regular  / 0 tracking
  Body Small:           14px  / Regular  / 0.1 tracking
  Caption:              12px  / Medium   / 0.2 tracking
  Overline:             10px  / Bold     / 1.5 tracking / UPPERCASE
  Song Title (Player):  22px  / Bold     / -0.3 tracking
  Artist (Player):      16px  / Regular  / 0 tracking
  Mini Player Title:    14px  / SemiBold / 0 tracking
  Mini Player Artist:   12px  / Regular  / 0.1 tracking
  Tab Label:            10px  / Medium   / 0.5 tracking
  Lyrics Active:        24px  / Bold     / -0.2 tracking
  Lyrics Inactive:      18px  / Regular  / 0 tracking / opacity 0.4

===============================================================================
SPACING & LAYOUT
===============================================================================

Base Unit:              4px
Spacing Scale:          4, 8, 12, 16, 20, 24, 32, 40, 48, 64

Screen Padding:         16px horizontal
Card Padding:           16px
Card Gap:               12px
Section Gap:            32px
List Item Height:       64px (song row), 72px (with subtitle)
Mini Player Height:     64px
Tab Bar Height:         56px (+ safe area)
Bottom Sheet Radius:    24px
Card Radius:            16px
Button Radius:          12px (large), 8px (small)
Avatar Radius:          50% (circle)
Album Art Radius:       12px (list), 8px (grid), 0px (full player)

===============================================================================
SHADOWS & ELEVATION
===============================================================================

Elevation 1 (cards):    0 2px 8px rgba(0, 0, 0, 0.3)
Elevation 2 (sheets):   0 4px 16px rgba(0, 0, 0, 0.4)
Elevation 3 (modals):   0 8px 32px rgba(0, 0, 0, 0.5)
Glow (accent):          0 0 20px rgba(108, 92, 231, 0.3)
Album Art Glow:         0 8px 40px rgba(0, 0, 0, 0.6)

===============================================================================
GLASSMORPHISM SPEC
===============================================================================

Glass Card:
  background:           rgba(22, 22, 42, 0.6)
  backdrop-filter:      blur(20px)
  border:               1px solid rgba(255, 255, 255, 0.08)
  border-radius:        16px

Glass Player:
  background:           rgba(13, 13, 20, 0.85)
  backdrop-filter:      blur(40px)
  border:               none

Glass Mini Player:
  background:           rgba(22, 22, 42, 0.9)
  backdrop-filter:      blur(24px)
  border-top:           1px solid rgba(255, 255, 255, 0.06)

===============================================================================
ANIMATIONS
===============================================================================

Duration:
  Instant:              100ms   (button press feedback)
  Fast:                 200ms   (toggles, small state changes)
  Normal:               300ms   (screen transitions, expand/collapse)
  Slow:                 500ms   (page transitions, hero animations)
  Emphasis:             800ms   (onboarding, celebration)

Easing:
  Default:              cubic-bezier(0.25, 0.1, 0.25, 1)
  Spring:               spring(damping: 15, stiffness: 150)
  Bounce:               spring(damping: 10, stiffness: 200)
  Decelerate:           cubic-bezier(0, 0, 0.2, 1)

===============================================================================
ICON SYSTEM
===============================================================================

Icon Set:               Phosphor Icons (consistent, modern)
Icon Sizes:             16px (inline), 20px (list), 24px (action bar), 28px (tab bar)
Icon Weight:            Regular (inactive), Fill (active/selected)
Icon Color Active:      #6C5CE7 (accent purple)
Icon Color Inactive:    #55556B (tertiary text)
Icon Color Player:      #EAEAEA (white-ish)

===============================================================================
COMPONENT TOKENS (QUICK REFERENCE)
===============================================================================

Button Primary:         bg #6C5CE7, text #FFF, radius 12px, h 48px
Button Secondary:       bg transparent, border 1px #6C5CE7, text #A29BFE, radius 12px
Button Ghost:           bg transparent, text #A29BFE, no border
Chip:                   bg #1A1A2E, text #EAEAEA, radius 20px, h 32px
Chip Active:            bg #6C5CE7, text #FFF
Input Field:            bg #1A1A2E, border 1px #2A2A3E, text #EAEAEA, radius 12px, h 48px
Input Focused:          border 1px #6C5CE7
Toggle On:              bg #6C5CE7, thumb #FFF
Toggle Off:             bg #2A2A3E, thumb #8B8B9E
Divider:                1px solid rgba(255, 255, 255, 0.06)
Skeleton Shimmer:       base #1A1A2E, highlight #2A2A3E

===============================================================================
DYNAMIC THEMING (ALBUM ART COLOR EXTRACTION)
===============================================================================

When song plays:
1. Extract dominant color from album art
2. Use as Player gradient background (dominant → black)
3. Apply as glow behind album art
4. Tint seek bar active color
5. Fallback to accent purple (#6C5CE7) if extraction fails
6. Ensure text contrast ratio >= 4.5:1 (WCAG AA)

===============================================================================
AMOLED BLACK VARIANT
===============================================================================

Override these values for AMOLED mode (true black saves battery on OLED):
  Primary Background:   #000000
  Secondary Background: #0A0A0A
  Tertiary Background:  #141414
  Surface:              #0F0F0F
  Mini Player BG:       #0A0A0A
  Card border:          rgba(255, 255, 255, 0.04)

Everything else stays same as dark theme.
