# User feedback worth coming back to

Collected from the forum thread (https://community.home-assistant.io/t/1030321) and GitHub. Not a todo list: ideas
and observations, with the context they came in.

## ddaniel, forum post 12, 2026-10-28

Network: 26 routers, 89 end devices, three floors, 326 links; first scan "a few minutes", does not mind.

- **Sensors for link quality / mesh health**: "include mqtt sensors, disabled by default, for devices lqi and some
  settings you put in config … show them in some card or such or send notification when lqi link is weak to add more
  routers." Our take: per-device LQI is noisy, but the mesh numbers (connected, redundant) as sensors and a per-router
  "weakest two-sided link" as disabled-by-default entities would carry a "redundant fell below 30" notification, which
  is the alert that tells you a router died before anything stops working. Needs the threshold computation moved from
  the panel into the integration. A release of its own.
- His screenshots showed ~40 devices parked at the bottom at "connected ≥ 68": the Min LQI threshold was cutting
  end-device links (one-sided by nature, often 40–60), not offline devices. Fixed 2026-10-29: Min LQI filters router
  links only.

## ddaniel, forum post 6, 2026-10-26

- Labels too small even when zoomed (they scale with zoom; the pill labels since 2026-10-28 are larger and coloured).
- Compared the panel to Zigporter; suggested "pivoting to something else".

## mmstano, forum post 2, 2026-10-25

- Uses the existing Zigbee Map card for its floorplan import and manual device arrangement.
