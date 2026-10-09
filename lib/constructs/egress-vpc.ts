import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as networkmanager from "aws-cdk-lib/aws-networkmanager";
import { Construct } from "constructs";
import { cloudWanTagKey } from "../network-config";

export interface EgressVpcProps {
  /** VPC CIDR block */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN segment tag value */
  readonly cloudWanSegmentTag: string;
}

export class EgressVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: EgressVpcProps) {
    super(scope, id);

    // VPC + subnets + IGW + NAT GW built by L2
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 1,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: "Nat", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "CloudWanAttachment",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    const natSubnet = vpc.publicSubnets[0];
    const cloudWanSubnet = vpc.privateSubnets[0];

    // Cloud WAN VPC Attachment
    const attachment = new networkmanager.CfnVpcAttachment(
      this,
      "CloudWanAttachment",
      {
        coreNetworkId: props.coreNetworkId,
        vpcArn: vpc.vpcArn,
        subnetArns: [
          cdk.Arn.format(
            {
              service: "ec2",
              resource: "subnet",
              resourceName: cloudWanSubnet.subnetId,
            },
            cdk.Stack.of(this)
          ),
        ],
        tags: [
          { key: cloudWanTagKey.Segment, value: props.cloudWanSegmentTag },
        ],
      }
    );

    // NAT subnet: route return traffic back to Cloud WAN
    const coreNetworkRoute = new ec2.CfnRoute(
      this,
      "NatSubnetCoreNetworkRoute",
      {
        routeTableId: natSubnet.routeTable.routeTableId,
        destinationCidrBlock: "10.0.0.0/8",
        coreNetworkArn: props.coreNetworkArn,
      }
    );
    coreNetworkRoute.addDependency(attachment);
  }
}
