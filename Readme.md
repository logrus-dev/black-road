⚠️[OpenTofu](https://opentofu.org/blog/opentofu-1-7-0/) provides state encryption out of the box since April 2024. That update adressed a major part of the problems Black Road attempted to solve.

---
 
Black Road is a deployment tool. It is an automation script on the top of HashiCorp's [Terraform](https://www.terraform.io) and [Vault](https://www.vaultproject.io/) projects, written using [zx](https://google.github.io/zx) NodeJS package. It implements a very custom deployment pattern which solves very specific issues which occur when using Terraform or Vault directly. In particular:

1. Black Road is a tool for **manual** deployment running from local machine.
1. It is not designed to work inside CI/CD workflow.
1. It is not designed for enterprise projects. It is for individuals who work with small deployments and want to reduce own devops time.
1. It does not support parallelism (not leveraging Terraform [locking](https://developer.hashicorp.com/terraform/language/state/locking) features).
1. Application being deployed does not use Vault API. If it does, Black Road does not make almost any sense to use, it's entirely different case.

The following docs cover only cases in scope of the boundaries declared above.

## Prerequisites

The machine which is running Black Road must meet the following requirements:

1. Linux-based/WSL operating system
1. [Terraform](https://developer.hashicorp.com/terraform/downloads) CLI installed
1. [Vault](https://developer.hashicorp.com/vault/docs/install) CLI installed (remote server is **not** needed and **not** supported)
1. [GPG](https://gnupg.org/download/) CLI installed and a private key exists in the keyring
1. [AWS](https://aws.amazon.com/cli/) CLI installed
1. [zx](https://google.github.io/zx/getting-started#install) CLI installed

## Core concepts

### Terraform back end

Terraform [back end](https://developer.hashicorp.com/terraform/language/settings/backends/configuration) is the place where state file is saved. It is a [know fact](https://github.com/hashicorp/terraform/issues/9556) that Terraform does not support state encryption. It is an old issue which seems to be out of the scope for HashiCorp. At the same time, Terraform state, by design, contains all environment variables passed to the cloud resources. Environment variables are pretty standard way to pass various secrets to an app. Black Road is solving this security breach by encrypting/decrypting state file using a pre-installed GPG key. Encryption occurs on the fly, right after downloading state from the remote and right before uploading it back. Since there is no official way to manipulate state file in the generic back end lifecycle, Black Road supports only [local](https://developer.hashicorp.com/terraform/language/settings/backends/local) back end with default file location in the current working directory in the file named `terraform.tfstate`. This approach covers most of the scenarios. On the top of the local Terraform back end and GPG at-rest encryption, Black Road implements saving encrypted state file to an [S3](https://aws.amazon.com/s3/)-compatible remote object storage and downloading it before running Terraform commands.

An S3 secret key requires encryption by itself. It is a common approach to have it stored as [environment variable](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html) or in .env file. However, these practices are not considered safe for obvious reason - sensitive information is stored as plain text. To mitigate this issue, Black Road keeps S3 secrets in it's own config file, also encrypted by the same GPG key.

> Black Road encrypts Terraform state file by GPG key and saves it to an S3 bucket. S3 secret keys are stored encrypted in Black Road's own config file.

### Vault back end

Vault [back end](https://developer.hashicorp.com/terraform/language/state/locking) is the place where encrypted secrets are stored by Vault server. Vault is a server application. This is an HTTP API which is exposed to the clients, including but not limited to Vault CLI. Unlike Terraform, Vault encrypts data before saving it to the storages. However, it suffers from the same issue when using [S3 back end](https://developer.hashicorp.com/vault/docs/configuration/storage/s3) - S3 client secrets are plain text.

Black Road runs Vault server locally, for a short period of time during deployment or when Vault UI needs to be accessed. This way there is no need to host a full-featured Vault cluster but a developer can still leverage the security Vault provides and integration capabilities between Vault and Terraform. Black Road runs Vault using S3 back end and supposes that Vault is already initialized (but maybe not filled with the secrets yet) in the provided S3 bucket.

> Black Road runs Vault server locally with S3 back end and encrypts S3 client secrets.

### Black Road back end

Black Road itself needs a storage for own config file. It supports only local file system and default file location in the current working directory in `black-road.json` file. This file contains S3 client secrets for Terraform and Vault back ends encrypted by GPG key. Since all sensitive data are encrypted, `black-road.json` can be safely saved to a VCS.

> Black Road maintains it's own config file which should be save to the source control system

## Deployment flow

1. `zx https://s.logrus.dev/black-road.mjs init` - an interactive shell will ask a series of questions for creating config file. All questions are optional (press Enter) but all parameters are mandatory - must be specified manually in the created file if skipped initially. This command does not call `terraform init`. The command is re-enterable - running it multiple times will update fields which are not skipped.
1. `zx https://s.logrus.dev/black-road.mjs vault` - starts local Vault server and prints URL to the Vault UI. URL includes 10-living auth token, so authentication is happening automatically when following the link, bypassing UI login screen.
1. `zx https://s.logrus.dev/black-road.mjs plan` - bypass to `terraform plan`. State file is loaded in advance and Vault server is started.
1. `zx https://s.logrus.dev/black-road.mjs apply` - bypass to `terraform apply`. State file is loaded in advance and Vault server is started. State file is sent back to the S3 and Vault is gracefully shut down right after Terraform is done work.

Obviously, `black-road.mjs` can be saved locally and modified according to the specific developer reasons.

> Black Road maintains Vault and Terraform persistence by providing them S3 back ends and securing S3 keys by GPG encryption. Terraform state file is also subject of encryption.

## Config options explained

| Name | Value |
|-|-|
|name|Name of Black Road project. Right now it is used only as a part of S3 key for Terraform state file.|
|vault.s3.endpoint|HTTP(s) endpoint of an S3-compatible object storage service. E.g., `https://s3.us-east-2.amazonaws.com`.|
|vault.s3.region|Region name. E.g., `eu-west-1`. Often ignored by non-AWS providers.|
|vault.s3.bucket|Name of the bucket to save Vault data. This bucket must be dedicated to Vault files, any existing object may be overwritten or lead to undetermined Vault behavior.|
|vault.s3.accessKey|Access key for authenticating access to the bucket. Non-encrypted, plain-text|
|vault.s3.secretKey|Secret key for authenticating access to the bucket. ***Encrypted*** by GPG key and base-64-encoded.|
|vault.unsealKey|[Unseal key portion](https://developer.hashicorp.com/vault/docs/concepts/seal) requested by `vault operator unseal`. ***Encrypted*** by GPG key and base-64-encoded.|
|vault.accessToken|A Vault [access token](https://developer.hashicorp.com/vault/docs/concepts/tokens). [root token](https://developer.hashicorp.com/vault/docs/concepts/tokens#root-tokens) for simplicity. ***Encrypted*** by GPG key and base-64-encoded.|
|terraform.s3.endpoint|HTTP(s) endpoint of an S3-compatible object storage service. E.g., `https://s3.us-east-2.amazonaws.com`.|
|terraform.s3.region|Region name. Often ignored by non-AWS providers. E.g., `eu-west-1`.|
|terraform.s3.bucket|Name of the bucket to save Terraform state file. This bucket should be dedicated to Terraform state files. Black Road creates them remotely using the following name pattern: `<name>.tfstate` where `<name>` - `name` option above in the table|
|terraform.s3.accessKey|Access key for authenticating access to the bucket. Non-encrypted, plain-text|
|terraform.s3.secretKey|Secret key for authenticating access to the bucket. ***Encrypted*** by GPG key and base-64-encoded.|

> A config file created by `init` command can be edited manually. This is a JSON file named `black-road.json` in the current working directory. Some of the fields are ***encrypted*** - those can be edited only by `init` command.

## GPG key

A GPG key should be generated, given a distinct, added to local keyring and securely saved. All that are outside of Black Road responsibility. The key can be secured with a passphrase. If so, it will be requested in the terminal each time running Black Road using default secure shell prompt.

> GPG key is the key to Black Road project. This is the entry point to a Black Road project and the only secret needs to be managed manually (in KeePass, for example).

## Misc.

### Core secrets and application secrets

It can be confusing that Black Road is running Vault - an industry standard secret management solution and at the same time is saving secrets to a JSON file, encrypted by GPG - another industry standard.

Vault is the solution for application secrets - the sensitive data used by the application which is being deployed by Black Road/Terraform. It has a descent integration with Terraform and provides nice web UI.

However, in order to run Vault itself, a bunch of secrets is required. Those secrets cannot be managed by Vault for obvious reason - Vault is not set up yet.

Running Vault as an online service is a complicated and crucial [procedure](https://developer.hashicorp.com/vault/tutorials/getting-started/getting-started-deploy). It is probably not worth efforts if the only consumer of it - local build process. Applications which use Vault API is a different story which is out of scope. On the other hand, Terraform needs it for a very short period of time. That is why Black Road is following so special pattern.
