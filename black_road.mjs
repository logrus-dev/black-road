#!/usr/bin/env zx

$.verbose = false

import 'zx/globals'

const sysDir = './.black-road';
const configPath = './black-road.json';
const vaultConfigPath = `${sysDir}/vault.hcl`;
const vaultHost = '127.0.0.1:8200';
const vaultUrl = `http://${vaultHost}`;

const prompt = async (msg, def) => {
  const value = await question(msg);
  return value && value.trim() || def;
};

const info = (msg) => echo(chalk.blue(msg));
const error = (msg) => echo(chalk.red(msg));

const preconditions = async () => {
  const [gpg] = await which('gpg');
  if (!gpg) {
    error('Black Road needs gpg utility installed to work. Install it using the system package manager');
    return false;
  }

  const [vault] = await which('vault');
  if (!vault) {
    error('Black Road needs Hashicorp Vault installed to work. Install it using the system package manager');
    return false;
  }

  const [terraform] = await which('terraform');
  if (!terraform) {
    error('Black Road needs terraform utility installed to work. Install it using the system package manager');
    return false;
  }

  const [aws] = await which('aws');
  if (!aws) {
    error('Black Road needs AWS CLI installed to work. Install it using the system package manager');
    return false;
  }

  return true;
};

const encrypt = async (gpgKeyName, str) => {
  const gpg = $`gpg --always-trust --yes --encrypt -r "${gpgKeyName}"`;
  const base64 = gpg.pipe($`base64`);
  gpg.stdin.write(str);
  gpg.stdin.end();

  return (await base64).stdout;
};

const decrypt = async (gpgKeyName, str) => {
  try {
    const base64 = $`base64 --decode > /tmp/black_road_stdin`;
    base64.stdin.write(str);
    base64.stdin.end();
    await base64;

    return (await $`gpg --decrypt -r "${gpgKeyName}" /tmp/black_road_stdin`).stdout;
  } finally {
    await $`rm -f /tmp/black_road_stdin`;
  }
};

const loadConfig = async (gpgKeyName) => {
  if (!await fs.exists(configPath)) {
    return {
      name: null,
      gpg: {
        key: null,
      },
      vault: {
        s3: {}
      },
      terraform: {
        s3: {}
      }
    };
  }

  const config = JSON.parse(await fs.readFile(configPath));
  gpgKeyName = config.gpg.key || gpgKeyName;
  config.vault.s3.secretKey = config.vault.s3.secretKey && await decrypt(gpgKeyName, config.vault.s3.secretKey) || null;
  config.vault.unsealKey = config.vault.unsealKey && await decrypt(gpgKeyName, config.vault.unsealKey) || null;
  config.vault.accessToken = config.vault.accessToken && await decrypt(gpgKeyName, config.vault.accessToken) || null;
  config.terraform.s3.secretKey = config.terraform.s3.secretKey && await decrypt(gpgKeyName, config.terraform.s3.secretKey) || null;

  return config;
};

const saveConfig = async (gpgKeyName, config) => {
  config = JSON.parse(JSON.stringify(config));
  config.gpg = {
    key: gpgKeyName,
  };
  config.vault.s3.secretKey = config.vault.s3.secretKey && await encrypt(gpgKeyName, config.vault.s3.secretKey) || null;
  config.vault.unsealKey = config.vault.unsealKey && await encrypt(gpgKeyName, config.vault.unsealKey) || null;
  config.vault.accessToken = config.vault.accessToken && await encrypt(gpgKeyName, config.vault.accessToken) || null;
  config.terraform.s3.secretKey = config.terraform.s3.secretKey && await encrypt(gpgKeyName, config.terraform.s3.secretKey) || null;

  await $`mkdir -p ${path.dirname(configPath)}`;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
};

const startVault = async (config) => spinner('Starting Vault...', async () => {
  const vaultProcess = within(() => {
    $.env = {
      AWS_ACCESS_KEY_ID: config.vault.s3.accessKey,
      AWS_SECRET_ACCESS_KEY: config.vault.s3.secretKey,
    };
    return $`vault server -config ${vaultConfigPath}`;
  });

  // vault status returns error code alongside with success message
  await retry(5, '3s', async () => {
    const status = await $`vault status -address="${vaultUrl}" | tr -s ' ' | grep 'Initialized true'`.nothrow();

    if (!status || status.toString().trim() !== 'Initialized true') {
      throw new Error('Vault is not started or not initialized');
    }
  });

  await $`vault operator unseal -address="${vaultUrl}" ${config.vault.unsealKey}`;
  await $`vault login -address="${vaultUrl}" ${config.vault.accessToken}`;

  info('Vault is up, unsealed and logged in');

  return [vaultProcess];
});

const init = async () => {
  if (!await preconditions()) return;

  const gpgKeyName = await question('Name of GPG key to use when working with the root secrets: ');
  if (await $`gpg --list-secret-keys | grep -w ${gpgKeyName}`.exitCode !== 0) {
    error('gpg key does not exist in the local keychain');
    return;
  }

  await $`gpgconf --kill gpg-agent`;
  info(await decrypt(gpgKeyName, await encrypt(gpgKeyName, 'GPG key verified')));

  const config = await loadConfig();

  config.name = await prompt('Project name (will be used for saving Terraform state): ', config.name);

  config.vault.s3.endpoint = await prompt('S3 endpoint for Hashicorp Vault back end: ', config.vault.s3.endpoint);
  config.vault.s3.region = await prompt('S3 region for Hashicorp Vault back end: ', config.vault.s3.region);
  config.vault.s3.bucket = await prompt('S3 bucket for Hashicorp Vault back end: ', config.vault.s3.bucket);
  config.vault.s3.accessKey = await prompt('S3 access key for Hashicorp Vault back end: ', config.vault.s3.accessKey);
  config.vault.s3.secretKey = await prompt('S3 secret key for Hashicorp Vault back end: ', config.vault.s3.secretKey);
  config.vault.unsealKey = await prompt('Hashicorp Vault unseal key: ', config.vault.unsealKey);
  config.vault.accessToken = await prompt('Hashicorp Vault access token: ', config.vault.accessToken);

  config.terraform.s3.endpoint = await prompt('S3 endpoint for Hashicorp Terraform back end: ', config.terraform.s3.endpoint);
  config.terraform.s3.region = await prompt('S3 region for Hashicorp Terraform back end: ', config.terraform.s3.region);
  config.terraform.s3.bucket = await prompt('S3 bucket for Hashicorp Terraform back end: ', config.terraform.s3.bucket);
  config.terraform.s3.accessKey = await prompt('S3 access key for Hashicorp Terraform back end: ', config.terraform.s3.accessKey);
  config.terraform.s3.secretKey = await prompt('S3 secret key for Hashicorp Terraform back end: ', config.terraform.s3.secretKey);

  await saveConfig(gpgKeyName, config);

  info(`Config file was saved at ${configPath}`);

  const vaultConfig = `
storage "s3" {
  bucket     = "${config.vault.s3.bucket}"
  endpoint   = "${config.vault.s3.endpoint}"
  region     = "${config.vault.s3.region}"
}

listener "tcp" {
  address     = "${vaultHost}"
  tls_disable = "true"
}

api_addr = "${vaultUrl}"
cluster_addr = "https://127.0.0.1:8201"
ui = true`;

  await $`mkdir -p ${path.dirname(vaultConfigPath)}`;
  await fs.writeFile(vaultConfigPath, vaultConfig);

  info('Starting local Vault instance. S3 back end must be accessible and initialized (vault operator init)');
  const [vaultProcess] = await startVault(config);

  info('Vault is up');
  await vaultProcess.kill();
  info('Vault was gracefully shut down. Black road init sequence is complete.');
};

const loadRemoteTerraformState = async (config) => {
  const stateFilePath = `${config.name}.tfsate`;
  const encryptedStatePath = `${sysDir}/${stateFilePath}`;
  const remoteStateS3Url =`s3://${config.terraform.s3.bucket}/${stateFilePath}`;

  await within(async () => {
    $.env = {
      AWS_ACCESS_KEY_ID: config.terraform.s3.accessKey,
      AWS_SECRET_ACCESS_KEY: config.terraform.s3.secretKey,
      AWS_ENDPOINT_URL: config.terraform.s3.endpoint,
    };
    const { exitCode } = await $`aws s3api head-object --bucket ${config.terraform.s3.bucket} --key ${stateFilePath}`.nothrow();
    if (exitCode == 0) {
      info('Found remote Terraform state. Downloading...');
      await $`rm -f ${encryptedStatePath}`;
      await $`aws s3 cp "${remoteStateS3Url}" "${sysDir}" --endpoint-url "${config.terraform.s3.endpoint}"`;
      info('Downloaded remote Terraform state');

      info('Decrypting remote Terraform state');
      await $`rm -f ./terraform.tfstate`;
      await $`gpg --decrypt -o "./terraform.tfstate" -r "${config.gpg.key}" "${encryptedStatePath}"`;
      info('Decrypted remote Terraform state');
    } else {
      info('Remote Terraform state not found');
    }
  });
};

const saveRemoteTerraformState = async (config) => {
  const stateFilePath = `${config.name}.tfsate`;
  const encryptedStatePath = `${sysDir}/${stateFilePath}`;
  const remoteStateS3Url =`s3://${config.terraform.s3.bucket}/${stateFilePath}`;

  await within(async () => {
    $.env = {
      AWS_ACCESS_KEY_ID: config.terraform.s3.accessKey,
      AWS_SECRET_ACCESS_KEY: config.terraform.s3.secretKey,
      AWS_ENDPOINT_URL: config.terraform.s3.endpoint,
    };
    info('Encrypting remote Terraform state');
    await $`rm -f ${encryptedStatePath}`;
    await $`gpg --always-trust --yes --encrypt -o "${encryptedStatePath}" -r "${config.gpg.key}" ./terraform.tfstate`;
    info('Saving remote Terraform state');
    await $`aws s3 cp "${encryptedStatePath}" "${remoteStateS3Url}" --endpoint-url "${config.terraform.s3.endpoint}"`;
    info('Saved remote Terraform state');
  });
};

const apply = async () => {
  if (!await preconditions()) return;
  if (!await fs.exists(configPath)) {
    error('Run black-road init first');
    return;
  }

  await $`gpgconf --kill gpg-agent`;
  const config = await loadConfig();
  const [vaultProcess] = await startVault(config);

  await loadRemoteTerraformState(config);

  await within(() => {
    $.verbose = true;
    return $`terraform apply -auto-approve`;
  });

  await vaultProcess.kill();
  info('Vault was gracefully shut down');

  await saveRemoteTerraformState(config);
};

const plan = async () => {
  if (!await preconditions()) return;
  if (!await fs.exists(configPath)) {
    error('Run black-road init first');
    return;
  }

  await $`gpgconf --kill gpg-agent`;
  const config = await loadConfig();
  const [vaultProcess] = await startVault(config);

  await loadRemoteTerraformState(config);

  await within(() => {
    $.verbose = true;
    return $`terraform plan`;
  });

  await vaultProcess.kill();
  info('Vault was gracefully shut down');
};

switch (argv._[1]) {
  case 'init':
    await init();
    break;
  case 'apply':
    await apply();
    break;
  case 'plan':
      await plan();
      break;
  default:
    error('Welcome to Black Road deploy utility');
}

info('Exiting');
