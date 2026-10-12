# Server probe

Uses hello/welcome and ping/pong. An HTTP 101 alone is not proof of protocol compatibility. RTT is distinct from total connection time. welcome.app falls back to /healthz.app. Unknown versions remain unknown, not incompatible. The selected server remains unchanged.
