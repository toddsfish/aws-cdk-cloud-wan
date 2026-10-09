#!/bin/bash -xe

# Variable substitution via CloudFormation Fn::Sub:
# ${VPNID}, ${REGION}, ${VPC_CIDR} are replaced by CloudFormation at deploy time.
# ${!VAR} is expanded as a shell variable at EC2 boot (Fn::Sub escape syntax).

#######################################
# 1. Install packages
#######################################

# Enable IP forwarding (router forwards packets)
sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-vpn.conf
sysctl -p /etc/sysctl.d/99-vpn.conf

# Install IPsec (Libreswan) and tools
dnf install -y jq unzip libreswan

# FRR is not in the AL2023 base repo; install from SPAL
dnf install -y spal-release
dnf install -y frr

#######################################
# 2. FRR daemon config
#######################################

# Enable BGP daemon (disabled by default)
sed -i "s/bgpd=.*/bgpd=yes/g" /etc/frr/daemons

# Add -n to zebra to enable the netns backend.
# This lets FRR see interfaces inside the network namespace (vrf1).
# Without -n, vrf-id is -1 and the BGP session never establishes.
sed -i 's/zebra_options=" *-A/zebra_options=" -n -A/g' /etc/frr/daemons

#######################################
# 3. Libreswan init
#######################################

# Initialize NSS crypto DB (Libreswan stores certs/keys there)
ipsec initnss 2>/dev/null || true

#######################################
# 4. Fetch IP addresses / VPN tunnel info
#######################################

# Get IMDSv2 token (long TTL: IMDS is used again after the VPN wait)
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 1800")
CGW_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/public-ipv4)
CGW_PRIVATE_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/local-ipv4)

# Fetch VPN tunnel info from the AWS API once (fewer calls, avoids throttling)
VPN_JSON=$(aws ec2 describe-vpn-connections --vpn-connection-ids ${VPNID} --region ${REGION} --no-cli-pager)
OUTSIDE_IP_ADDRESS1=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[0].OutsideIpAddress')
OUTSIDE_IP_ADDRESS2=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[1].OutsideIpAddress')

#######################################
# 5. Libreswan (IPsec) config
#######################################

# Pre-shared key
cat <<IPSECSECRETSEOF > /etc/ipsec.d/cloudwan.secrets
${!CGW_IP_ADDRESS} ${!OUTSIDE_IP_ADDRESS1} : PSK "vpnsecret"
${!CGW_IP_ADDRESS} ${!OUTSIDE_IP_ADDRESS2} : PSK "vpnsecret"
IPSECSECRETSEOF

# IPsec tunnel config
# - ikev2=insist: force IKEv2 (matches AWS VPN config)
# - dpddelay/dpdtimeout: send DPD probes every 10s so AWS sees the tunnel UP
# - vti-interface: Libreswan creates the VTI device
# - vti-routing=no: leave VTI routing to FRR (BGP)
cat <<IPSECCONFEOF > /etc/ipsec.d/cloudwan.conf
conn tunnel1
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${!CGW_PRIVATE_IP_ADDRESS}
  leftid=${!CGW_IP_ADDRESS}
  leftsubnet=0.0.0.0/0
  right=${!OUTSIDE_IP_ADDRESS1}
  rightid=${!OUTSIDE_IP_ADDRESS1}
  rightsubnet=0.0.0.0/0
  mark=100/0xffffffff
  vti-interface=vti1
  vti-routing=no

conn tunnel2
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${!CGW_PRIVATE_IP_ADDRESS}
  leftid=${!CGW_IP_ADDRESS}
  leftsubnet=0.0.0.0/0
  right=${!OUTSIDE_IP_ADDRESS2}
  rightid=${!OUTSIDE_IP_ADDRESS2}
  rightsubnet=0.0.0.0/0
  mark=200/0xffffffff
  vti-interface=vti2
  vti-routing=no
IPSECCONFEOF

#######################################
# 6. Start IPsec + bring up tunnels
#######################################

systemctl enable ipsec
systemctl start ipsec

# On fresh stack creation, SiteToSiteVpnAttachment takes 10+ minutes.
# ipsec auto --up fails unless we wait for the VPN endpoint to respond.
echo "Waiting for VPN Connection to become available..."
for i in $(seq 1 90); do
  STATE=$(aws ec2 describe-vpn-connections --vpn-connection-ids ${VPNID} --region ${REGION} --no-cli-pager 2>/dev/null | jq -r '.VpnConnections[].State')
  if [ "${!STATE}" = "available" ]; then
    echo "VPN Connection available (check ${!i})"
    break
  fi
  echo "Waiting for VPN Connection... (state: ${!STATE}, ${!i}/90)"
  sleep 10
done

# Restart ipsec to load the latest config, then start connections explicitly.
# Retry: the endpoint can take a few seconds even after it becomes available.
ipsec restart
sleep 5

for i in $(seq 1 30); do
  if ipsec auto --up tunnel1 2>&1 | grep -q "established"; then
    echo "Tunnel 1 established"
    break
  fi
  echo "Connecting Tunnel 1... (${!i}/30)"
  sleep 10
done

for i in $(seq 1 30); do
  if ipsec auto --up tunnel2 2>&1 | grep -q "established"; then
    echo "Tunnel 2 established"
    break
  fi
  echo "Connecting Tunnel 2... (${!i}/30)"
  sleep 10
done

#######################################
# 7. Wait for VTI
#######################################

# Libreswan creates the VTI device when the IPsec SA is established.
# Wait, since later IP config and namespace moves need the VTI.
for i in $(seq 1 30); do
  if ip link show vti1 > /dev/null 2>&1 && ip link show vti2 > /dev/null 2>&1; then
    echo "VTI device created"
    break
  fi
  echo "Waiting for VTI... (${!i}/30)"
  sleep 2
done

#######################################
# 8. Build network namespace
#######################################

# Use a namespace to separate the on-prem LAN side (ens6) and VPN tunnels (vti1/2)
# from the main VPC routing.
# This keeps FRR BGP routes from clashing with VPC local routes.
NAMESPACE=vrf1
ip netns add ${!NAMESPACE}

# Detect the DeviceIndex=1 interface name via its IMDS MAC address.
# AL2023 uses predictable names (ens6, etc.) but they can vary by instance type, so don't hardcode.
for mac in $(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/network/interfaces/macs/ | tr -d '/'); do
  dn=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${!mac}/device-number")
  if [ "${!dn}" = "1" ]; then
    ETH1_IFACE=$(ip -o link | grep -i "${!mac}" | awk -F': ' '{print $2}')
    ETH1_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${!mac}/local-ipv4s")
    echo "DeviceIndex 1 = ${!ETH1_IFACE} (MAC: ${!mac}, IP: ${!ETH1_IP})"
    break
  fi
done

# Move on-prem LAN interface into the namespace
ip link set ${!ETH1_IFACE} netns ${!NAMESPACE} up
ip netns exec ${!NAMESPACE} ip addr add ${!ETH1_IP}/24 dev ${!ETH1_IFACE}

#######################################
# 9. Move VTIs into namespace + set tunnel inside IPs
#######################################

# Moving VTIs into the namespace makes BGP peer inside vrf1
ip link set vti1 netns ${!NAMESPACE}
ip netns exec ${!NAMESPACE} ip link set vti1 up mtu 1436
ip link set vti2 netns ${!NAMESPACE}
ip netns exec ${!NAMESPACE} ip link set vti2 up mtu 1436

# Set tunnel inside IPs fetched from the AWS API.
# In the /30, network+1 is the AWS side, network+2 is the CGW side.
TUNNEL_IP_CIDR1=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[0].TunnelInsideCidr')
TUNNEL_IP_CIDR2=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[1].TunnelInsideCidr')

TUNNEL_NET1=$(echo ${!TUNNEL_IP_CIDR1} | cut -d/ -f1 | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, int($4/4)*4}')
TUNNEL_IP_ADDRESS1_AWS=$(echo ${!TUNNEL_NET1} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+1}')
TUNNEL_IP_ADDRESS1_CGW=$(echo ${!TUNNEL_NET1} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+2}')
TUNNEL_NET2=$(echo ${!TUNNEL_IP_CIDR2} | cut -d/ -f1 | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, int($4/4)*4}')
TUNNEL_IP_ADDRESS2_AWS=$(echo ${!TUNNEL_NET2} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+1}')
TUNNEL_IP_ADDRESS2_CGW=$(echo ${!TUNNEL_NET2} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+2}')

ip netns exec ${!NAMESPACE} ip addr add ${!TUNNEL_IP_ADDRESS1_CGW}/30 dev vti1
ip netns exec ${!NAMESPACE} ip addr add ${!TUNNEL_IP_ADDRESS2_CGW}/30 dev vti2

#######################################
# 10. FRR (BGP) config
#######################################

# Run BGP in VRF vrf1 and exchange routes with Cloud WAN.
# - AS 64901: this on-prem router's ASN
# - remote-as 65002: Cloud WAN Region2 ASN
# - aggregate-address: advertise the VPC CIDR as a summary
# - route-map ALLOW_OUT: restrict advertised prefixes
cat <<FRREOF > /etc/frr/frr.conf
frr version 10.4
frr defaults traditional
hostname vpn-router
log syslog informational
no ipv6 forwarding
!
vrf vrf1
 netns /run/netns/vrf1
exit-vrf
!
router bgp 64901 vrf vrf1
 no bgp ebgp-requires-policy
 neighbor ${!TUNNEL_IP_ADDRESS1_AWS} remote-as 65002
 neighbor ${!TUNNEL_IP_ADDRESS1_AWS} ebgp-multihop 255
 neighbor ${!TUNNEL_IP_ADDRESS2_AWS} remote-as 65002
 neighbor ${!TUNNEL_IP_ADDRESS2_AWS} ebgp-multihop 255
 !
 address-family ipv4 unicast
  redistribute connected
  aggregate-address ${VPC_CIDR} summary-only
  neighbor ${!TUNNEL_IP_ADDRESS1_AWS} soft-reconfiguration inbound
  neighbor ${!TUNNEL_IP_ADDRESS2_AWS} soft-reconfiguration inbound
  neighbor ${!TUNNEL_IP_ADDRESS1_AWS} route-map ALLOW_OUT out
  neighbor ${!TUNNEL_IP_ADDRESS2_AWS} route-map ALLOW_OUT out
 exit-address-family
exit
!
ip prefix-list LOCAL seq 5 permit ${VPC_CIDR}
!
route-map ALLOW_OUT permit 10
 match ip address prefix-list LOCAL
exit
!
end
FRREOF

systemctl enable frr
systemctl restart frr
