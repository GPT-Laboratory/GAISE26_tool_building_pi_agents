#!/usr/bin/env bash
# Egress allowlist for workshop containers.
# Permits only traffic to openrouter.ai; drops everything else from containers.
#
# Run as root just before doors open (OpenRouter IPs may change).
# Usage: sudo ./scripts/hardening.sh [--remove]
#
# The workshop Docker bridge is assumed to be named "workshop".

set -euo pipefail

CHAIN="WORKSHOP_EGRESS"
BRIDGE_NAME="workshop"
REMOVE="${1:-}"

# Resolve bridge subnet from Docker
BRIDGE_SUBNET="$(docker network inspect workshop --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || echo '')"
if [[ -z "$BRIDGE_SUBNET" ]]; then
  echo "Error: Docker network 'workshop' not found or no subnet. Start the backend first." >&2
  exit 1
fi
echo "Bridge subnet: $BRIDGE_SUBNET"

# Resolve OpenRouter IPs
OPENROUTER_IPS="$(dig +short openrouter.ai | grep -E '^[0-9]')"
if [[ -z "$OPENROUTER_IPS" ]]; then
  echo "Error: Could not resolve openrouter.ai. Check DNS." >&2
  exit 1
fi
echo "OpenRouter IPs: $(echo $OPENROUTER_IPS | tr '\n' ' ')"

if [[ "$REMOVE" == "--remove" ]]; then
  echo "Removing egress rules…"
  iptables -D FORWARD -s "$BRIDGE_SUBNET" -j "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  echo "Removed."
  exit 0
fi

# Remove existing chain if present (idempotent re-run)
iptables -D FORWARD -s "$BRIDGE_SUBNET" -j "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN" 2>/dev/null || true
iptables -X "$CHAIN" 2>/dev/null || true

# Create the chain
iptables -N "$CHAIN"

# Allow established/related (return traffic for allowed outbound connections)
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP/TCP 53) to any — containers need name resolution for OpenRouter
iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT

# Allow HTTPS to each OpenRouter IP
while IFS= read -r ip; do
  [[ -z "$ip" ]] && continue
  echo "  ACCEPT -> $ip:443"
  iptables -A "$CHAIN" -d "$ip" -p tcp --dport 443 -j ACCEPT
done <<< "$OPENROUTER_IPS"

# Default DROP (log first so issues are visible)
iptables -A "$CHAIN" -j LOG --log-prefix "[WORKSHOP DROP] " --log-level 4
iptables -A "$CHAIN" -j DROP

# Insert jump at FORWARD chain (before other rules)
iptables -I FORWARD 1 -s "$BRIDGE_SUBNET" -j "$CHAIN"

echo "Egress allowlist applied."
echo "Verify with: iptables -L FORWARD -nv && iptables -L $CHAIN -nv"
