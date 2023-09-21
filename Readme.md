Black Road is a deployment tool. It is an automation script on the top of HashiCorp's [Terraform](https://www.terraform.io) and [Vault](https://www.vaultproject.io/) projects. It implements a very custom deployment pattern which solves very specific issues which occur when using Terraform or Vault directly. In particular:

1. Black Road is a tool for **manual** deployment running from local machine.
1. It is not designed to work inside CI/CD workflow.
1. It is not designed for enterprise projects. It is for individuals who work with small deployments and want to reduce own devops time.
1. It does not support parallelism (not leveraging Terraform [locking](https://developer.hashicorp.com/terraform/language/state/locking) features).

The following docs covers only cases in scope of the boundaries declared above.

## Prerequisites

1. Linux-based/WSL operating system
1. [Terraform](https://developer.hashicorp.com/terraform/downloads) CLI installed
1. [Vault](https://developer.hashicorp.com/vault/docs/install) CLI installed (remote server is **not** needed and **not** supported)
1. [GPG](https://gnupg.org/download/) CLI installed and a private key exists in the keyring
1. [AWS](https://aws.amazon.com/cli/) CLI installed
1. [zx](https://google.github.io/zx/getting-started#install) CLI installed

## Core concepts

### Terraform back end

Terraform [back end](https://developer.hashicorp.com/terraform/language/settings/backends/configuration) is the place where state file is saved. It is a [know fact](https://github.com/hashicorp/terraform/issues/9556) that Terraform does not support state encryption. It is an old issue which seems to be out of the scope for HashiCorp. Black Road is solving this by encrypting/decrypting state file using a pre-installed GPG key. Encryption occurs on the fly, right after downloading state from the remote and right before uploading it back. Since there is no official way to manipulate state file in the generic back end lifecycle, Black Road supports only [local](https://developer.hashicorp.com/terraform/language/settings/backends/local) back end with default file location in the current working directory in the file named `terraform.tfstate`. This approach covers most of the scenarios. On the top of the local Terraform back end and GPG at-rest encryption, Black Road implements saving encrypted state file to an [S3](https://aws.amazon.com/s3/)-compatible remote object storage.

The S3 keys require encryption by themselves. It is a common approach to have them stored as [environment variables](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html) or in .env files. However, these practices are not considered safe for obvious reason - sensitive information is stored as plain text. To mitigate this issue, Black Road keeps S3 secrets in it's own config file, also encrypted by the same GPG key.

> Black Road encrypts Terraform state file by GPG key and saves it to an S3 bucket.

### Vault back end

Vault [back end](https://developer.hashicorp.com/terraform/language/state/locking) is the place where encrypted secrets are stored by Vault server. Vault is a server application. This is an HTTP API which is exposed to the clients, including but not limited to Vault CLI. Unlike Terraform, Vault encrypts data before saving it to the storages. However, it suffers from the same issue when using [S3 back end](https://developer.hashicorp.com/vault/docs/configuration/storage/s3) - S3 client secrets are plain text.

Black Road runs Vault server locally, for a short period of time during deployment or when Vault UI needs to be accessed. This way there is no need to host a full-featured Vault cluster but a developer can still leverage the security Vault provides and integration capabilities between Vault and Terraform. Black Road runs Vault using S3 back end and supposes that Vault is already initialized (but maybe not filled with the secrets yet) in the provided S3 bucket.

> Black Road runs Vault server locally with S3 back end and encrypts S3 client secrets.

### Black Road back end

Black Road itself needs a storage for own config file. It supports only local file system and default file location in the current working directory in `black-road.json` file. This file contains S3 client secrets for Terraform and Vault back ends encrypted by GPG key. Since all sensitive data are encrypted, `black-road.json` can be safely saved to a VCS.

> Black Road maintains it's own config file which should be save to the source control system

### Deployment flow

1. ``
