# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `pnpm build`   compile typescript to js
* `pnpm watch`   watch for changes and compile
* `pnpm test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Stack TTL

Both stacks extend `TempStack` ([@cloudcomponents/cdk-temp-stack](https://constructs.dev/packages/@cloudcomponents/cdk-temp-stack/v/2.4.0) 2.4.0). A Lambda deletes each stack after its TTL (`bin/aws-cdk-cloud-wan.ts`): Region2 45 min, Region1 75 min.

- The timer starts when the TTL resource is created (first in the stack), not when the deploy completes.
- `Schedule.rate()` repeats: failed deletes retry every TTL interval.
- Region1 TTL is longer so Region2 deletes first; Region1 deletion fails while Region2 attachments or cross-region imports exist.
