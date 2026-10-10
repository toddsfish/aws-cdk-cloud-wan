#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Region1Stack } from '../lib/region1-stack';
import { Region2Stack } from '../lib/region2-stack';

const app = new cdk.App();

const region1 = 'ap-southeast-2';
const region2 = 'us-west-2';

// Self-destruct timers (TempStack). Each timer starts when its stack's deploy starts.
// Region2 must delete first: it imports the core network ID/ARN and attaches to it.
// Region1 TTL = Region2 TTL + Region1 deploy (~25 min) + Region2 delete, plus margin.
//
//   T0      +25m           +70m        +75m
//   R1 ─────┤ R2 ──────────┤ R2 delete ┤ R1 delete
const region2Ttl = cdk.Duration.minutes(45);
const region1Ttl = region2Ttl.plus(cdk.Duration.minutes(30));

const region1Stack = new Region1Stack(app, 'CloudWanRegion1Stack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region1 },
  region2,
  ttl: region1Ttl,
  crossRegionReferences: true,
});

const region2Stack = new Region2Stack(app, 'CloudWanRegion2Stack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region2 },
  coreNetworkId: region1Stack.coreNetworkId,
  coreNetworkArn: region1Stack.coreNetworkArn,
  ttl: region2Ttl,
  crossRegionReferences: true,
});

region2Stack.addDependency(region1Stack);
