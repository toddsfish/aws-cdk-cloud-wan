/**
 * Central network configuration.
 * All CIDRs / IPs / ASNs / segment names are defined here and injected into Stacks / Constructs via Props.
 */

/** RFC1918 private address ranges */
export const RFC1918_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

/** Cloud WAN attachment tag keys */
export const cloudWanTagKey = {
  Segment: 'cloudwan-seg',
  Nfg: 'cloudwan-nfg',
} as const;

/** Cloud WAN segment names */
export const cloudWanSegment = {
  Share: 'share',
  Prod: 'prod',
  Dev: 'dev',
} as const;

/** Cloud WAN Network Function Group names */
export const cloudWanNfg = {
  Security: 'security',
} as const;

/** Cloud WAN Core Network settings */
export const CORE_NETWORK_CONFIG = {
  insideCidrBlocks: ['192.168.0.0/16'],
  asnRanges: ['65000-65099'],
  region1Asn: 65001,
  region2Asn: 65002,
  region2InsideCidr: '192.168.100.0/24',
} as const;

/** VPN settings */
export const VPN_CONFIG = {
  cgwBgpAsn: 64901,
  preSharedKey: 'vpnsecret',
  tunnel1InsideCidr: '169.254.10.0/30',
  tunnel2InsideCidr: '169.254.10.4/30',
} as const;

/** Per-VPC network settings */
export interface VpcNetworkConfig {
  readonly vpcCidr: string;
}

/** Per-region network settings */
export interface RegionNetworkConfig {
  readonly egress: VpcNetworkConfig;
  readonly prodPrivate: VpcNetworkConfig;
  readonly devPrivate?: VpcNetworkConfig;

  readonly inspection?: VpcNetworkConfig;
  readonly vpn?: VpcNetworkConfig;
}

/** Region1 network settings */
export const REGION1_NETWORK: RegionNetworkConfig = {
  egress: { vpcCidr: '10.0.0.0/16' },
  prodPrivate: { vpcCidr: '10.1.0.0/16' },
  devPrivate: { vpcCidr: '10.2.0.0/16' },
  inspection: { vpcCidr: '10.3.0.0/16' },
};

/** Region2 network settings */
export const REGION2_NETWORK: RegionNetworkConfig = {
  egress: { vpcCidr: '10.100.0.0/16' },
  prodPrivate: { vpcCidr: '10.101.0.0/16' },
  vpn: { vpcCidr: '10.102.0.0/16' },
};

/** All VPC CIDRs for NFW rule variables (keys become NFW IP set variable names) */
export const ALL_VPC_CIDRS = {
  Region1_EgressVPC_NET: [REGION1_NETWORK.egress.vpcCidr],
  Region1_ProdPrivateVPC_NET: [REGION1_NETWORK.prodPrivate.vpcCidr],
  Region1_DevPrivateVPC_NET: [REGION1_NETWORK.devPrivate!.vpcCidr],
  Region2_EgressVPC_NET: [REGION2_NETWORK.egress.vpcCidr],
  Region2_ProdPrivateVPC_NET: [REGION2_NETWORK.prodPrivate.vpcCidr],
  Region2_VpnVPC_NET: [REGION2_NETWORK.vpn!.vpcCidr],
} as const;
