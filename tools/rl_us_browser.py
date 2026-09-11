"""Compatibility entry for the original-skill browser regression.

The shared suite owns a port-0 server and checks the actual card's scene,
ordered payload, viewer controls, failure paths and twenty full performances.
"""
from skill_playback_browser import main

if __name__ == "__main__":
    main()
