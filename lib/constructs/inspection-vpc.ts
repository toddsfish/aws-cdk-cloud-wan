import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { ALL_VPC_CIDRS, cloudWanTagKey } from '../network-config';

export interface InspectionVpcProps {
  /** VPC CIDR block */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN Network Function Group tag value */
  readonly cloudWanNfgTag: string;
}

/**
 * Inspection VPC - Network Firewall inspection + internet egress.
 * Has NAT GW / IGW because it is used in send-to mode.
 * Inspected internet-bound traffic exits via NAT GW.
 * Return traffic to internal CIDRs goes back to the source via the Core Network.
 */
export class InspectionVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: InspectionVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Firewall', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'CloudWanAttachment', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    const publicSubnet = vpc.selectSubnets({ subnetGroupName: 'Public' }).subnets[0];
    const fwSubnet = vpc.selectSubnets({ subnetGroupName: 'Firewall' }).subnets[0];
    const cloudWanSubnet = vpc.selectSubnets({ subnetGroupName: 'CloudWanAttachment' }).subnets[0];

    // Network Firewall Rule Group
    // NOTE: ruleGroupName/firewallPolicyName/firewallName are required CFn L1 properties
    const nfwRuleGroup = new networkfirewall.CfnRuleGroup(this, 'NfwRuleGroup', {
      ruleGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-RuleGroup',
      capacity: 1000,
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: { ruleOrder: 'STRICT_ORDER' },
        ruleVariables: {
          ipSets: Object.fromEntries(
            Object.entries(ALL_VPC_CIDRS).map(([key, cidrs]) => [
              key, { definition: [...cidrs] },
            ]),
          ),
        },
        rulesSource: {
          rulesString: [
            // Alert + pass TLS to a specific domain (SNI check on ssl_state:client_hello)
            'pass tls any any -> any any (ssl_state:client_hello; tls.sni; content:"checkip.amazonaws.com"; flow:to_server,established; alert; sid:2000001; rev:1; msg:"Access to checkip.amazonaws.com detected";)',
            // Alert + pass ICMP
            'pass icmp any any -> any any (alert; sid:2000002; rev:1; msg:"ICMP ping detected";)',
            // Allow TCP handshake (before flow is established)
            'pass tcp any any -> any any (flow:not_established; sid:3000001; rev:1;)',
            // Allow established TLS (domains not alerted on)
            'pass tls any any -> any any (ssl_state:client_hello; flow:to_server,established; sid:3000002; rev:1;)',
            // Allow established TCP (non-TLS: HTTP, SSH, etc.)
            'pass tcp any any -> any any (flow:established; sid:3000003; rev:1;)',
            // Allow UDP
            'pass udp any any -> any any (sid:3000004; rev:1;)',
          ].join('\n') + '\n',
        },
      },
    });

    const nfwPolicy = new networkfirewall.CfnFirewallPolicy(this, 'NfwPolicy', {
      firewallPolicyName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Policy',
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulDefaultActions: ['aws:drop_established'],
        statefulEngineOptions: { ruleOrder: 'STRICT_ORDER' },
        statefulRuleGroupReferences: [
          { priority: 1, resourceArn: nfwRuleGroup.attrRuleGroupArn },
        ],
      },
    });

    const nfw = new networkfirewall.CfnFirewall(this, 'Nfw', {
      firewallName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Nfw',
      firewallPolicyArn: nfwPolicy.attrFirewallPolicyArn,
      subnetMappings: [{ subnetId: fwSubnet.subnetId }],
      vpcId: vpc.vpcId,
    });

    // Send NFW alert logs to CloudWatch Logs
    const nfwAlertLogGroup = new logs.LogGroup(this, 'NfwAlertLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new networkfirewall.CfnLoggingConfiguration(this, 'NfwLogging', {
      firewallArn: nfw.ref,
      loggingConfiguration: {
        logDestinationConfigs: [
          {
            logDestination: { logGroup: nfwAlertLogGroup.logGroupName },
            logDestinationType: 'CloudWatchLogs',
            logType: 'ALERT',
          },
        ],
      },
    });

    // Extract NFW VPC endpoint ID
    const fwEndpointId = cdk.Fn.select(
      1, cdk.Fn.split(':', cdk.Fn.join(',', nfw.attrEndpointIds)),
    );

    // Cloud WAN attachment subnet: traffic from Cloud WAN to NFW
    new ec2.CfnRoute(this, 'CloudWanSubnetDefaultRoute', {
      routeTableId: cloudWanSubnet.routeTable.routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: fwEndpointId,
    });

    // Public subnet: return traffic (RFC1918) back to Cloud WAN via NFW
    new ec2.CfnRoute(this, 'PublicSubnetInternalRoute', {
      routeTableId: publicSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      vpcEndpointId: fwEndpointId,
    });

    // FW subnet: inspected return traffic (RFC1918) to Cloud WAN
    // (internet-bound uses the L2-managed 0.0.0.0/0 -> NAT GW route)
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format({
          service: 'ec2', resource: 'subnet', resourceName: cloudWanSubnet.subnetId,
        }, cdk.Stack.of(this)),
      ],
      options: { applianceModeSupport: true },
      tags: [{ key: cloudWanTagKey.Nfg, value: props.cloudWanNfgTag }],
    });

    const fwInternalRoute = new ec2.CfnRoute(this, 'FwSubnetInternalRoute', {
      routeTableId: fwSubnet.routeTable.routeTableId,
      destinationCidrBlock: '10.0.0.0/8',
      coreNetworkArn: props.coreNetworkArn,
    });
    fwInternalRoute.addDependency(attachment);
  }
}
