# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

AWS CDK (TypeScript) lab for AWS Cloud WAN: two-region core network with segments, a Network Function Group (NFG) running AWS Network Firewall for inspection, and a simulated on-prem site over Site-to-Site VPN. Forked for Cloud WAN testing; not production.

## Commands

Package manager: pnpm (`pnpm-lock.yaml`).

```sh
pnpm install
pnpm type-check                      # tsc --noEmit
pnpm test                            # jest (ts-jest), test/*.test.ts
pnpm test -t 'creates Network Firewall'   # single test by name
pnpm cdk synth                       # both stacks
pnpm cdk diff  CloudWanRegion1Stack
pnpm cdk deploy --all                # Region1 first (dependency enforced)
pnpm cdk destroy --all
```

README lists `pnpm build` / `pnpm watch`; those scripts do not exist in `package.json`. The app runs via ts-node (`cdk.json`), so no compile step is needed.

## Architecture

```
bin/aws-cdk-cloud-wan.ts
 ├─ CloudWanRegion1Stack (ap-northeast-1)
 │   ├─ CoreNetwork   GlobalNetwork + CoreNetwork + policy (global resource, lives here)
 │   ├─ EgressVpc     seg=share   NAT GW egress
 │   ├─ PrivateVpc    seg=prod
 │   ├─ PrivateVpc    seg=dev
 │   └─ InspectionVpc nfg=security  Network Firewall + NAT GW
 └─ CloudWanRegion2Stack (us-east-1)  depends on Region1
     ├─ EgressVpc     seg=share
     ├─ PrivateVpc    seg=prod
     └─ VpnVpc        seg=dev   Libreswan+FRR EC2 router = fake on-prem, S2S VPN attachment
```

- **Cross-region refs**: `coreNetworkId`/`coreNetworkArn` flow Region1 → Region2 via `crossRegionReferences: true` (SSM-backed custom resources). Changing these outputs requires redeploying both stacks in order.
- **Single source of config**: `lib/network-config.ts` holds every CIDR, ASN, segment/NFG name, tag key and VPN setting. Stacks/constructs receive values via props; do not hardcode them in constructs. `ALL_VPC_CIDRS` keys become NFW IP-set variable names.
- **Segment association is tag-driven**: constructs only tag attachments (`cloudwan-seg` / `cloudwan-nfg`). The core network policy's `attachment-policies` (`lib/constructs/core-network.ts`) maps tag values to segments/NFG. Adding a segment means updating `cloudWanSegment`, the policy `segments`, and the attachment-policy rules together.
- **Routing intent (policy `segment-actions`)**:
  - `share` routes shared into `dev`.
  - `prod` is `isolate-attachments`; `send-to` the security NFG (internet egress through InspectionVpc) and `send-via` single-hop for prod↔prod (east-west inspection).
  - Only Region1 has an InspectionVpc; Region2 prod traffic is inspected cross-region.
- **InspectionVpc routing**: Cloud WAN subnet `0.0.0.0/0` → NFW endpoint; FW subnet `10.0.0.0/8` → core network, default → NAT GW; public subnet `10.0.0.0/8` → NFW (symmetric return). Attachment uses `applianceModeSupport`. NFW endpoint ID is parsed from `attrEndpointIds` (`az:vpce-id`) with `Fn.split`/`Fn.select`. Stateful rules are `STRICT_ORDER` with default `drop_established`; ALERT logs go to CloudWatch.
- **Core-network routes** (`CfnRoute` with `coreNetworkArn`) must `addDependency(attachment)` or deploy fails before the attachment is available.
- **VPN router**: `src/ec2/vpn-router-userdata.sh` is injected with `Fn.sub` (`${VPNID}`, `${REGION}`, `${VPC_CIDR}` are CFn-substituted; shell vars must be escaped as `${!VAR}`). At boot it reads tunnel details via `ec2:DescribeVpnConnections` and configures Libreswan + FRR BGP (CGW ASN `64901`).
- All VPCs are single-AZ (`maxAzs: 1`) to keep cost down. Private VPCs use EC2 Instance Connect Endpoints + SSM for access.

## Conventions

- L2 constructs where available; L1 (`Cfn*`) for Network Manager, NFW, VPN, multi-ENI instances.
- Code comments in English. Commit messages: Conventional Commits (history before the English conversion is Japanese).
- Tests (`test/aws-cdk-cloud-wan.test.ts`) assert synthesized resources and attachment tags using constants from `network-config.ts`.
