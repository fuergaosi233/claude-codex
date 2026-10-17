// The variables the Claude CLI never fills into an MCP server's config, as
// its 2.1.283 build has them, for the adapter's own calls to a server (the
// App's tool calls and resource reads) to fill a config in as the CLI does
// for the servers it starts. Names compare in upper case, with or without the
// INPUT_ prefix GitHub Actions gives its inputs.

const names = (list: string) => new Set(list.trim().split(/\s+/))

// Claude's own: ANTHROPIC_*, CLAUDE_CODE_*, these and OTEL_*. Set, they read
// as empty anywhere in a config. Left out are the ones the CLI adds only for
// a provider its host manages, a bridged session or HIPAA mode.
const OWN = names(`
  CLAUDE_BRIDGE_OAUTH_TOKEN CLAUDE_TRUSTED_DEVICE_TOKEN AGENT_PROXY_AUTH_TOKEN
  CLAUDE_SESSION_INGRESS_TOKEN_FILE MCP_CLIENT_SECRET MCP_XAA_IDP_CLIENT_SECRET
  ENVIRONMENT_SERVICE_KEY SELF_HOSTED_RUNNER_POOL_SECRET SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET
  CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_BG_SOCKET_TOKENS_PATH CLAUDE_BG_RV_AUTH CLAUDE_BG_PTY_AUTH
  CLAUDE_BG_CLAIM_AUTH CLAUDE_BG_SOURCE CLAUDE_BG_ISOLATION CLAUDE_BG_BACKEND
  CLAUDE_BG_POST_CLEAR_RESPAWN CLAUDE_BG_SESSION_PERMISSION_RULES CLAUDE_BG_MEMORY_TOGGLED_OFF
  CLAUDE_BG_WORKSPACE_TRUSTED CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE
  CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER
`)

// Credentials the CLI keeps from remote servers on top of its own. In a
// remote server's url or headers they read as empty whether set or not, a
// default included. The Hugging Face tokens on its list it does pass on.
const REMOTE = names(`
  AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_BEARER_TOKEN_BEDROCK GOOGLE_APPLICATION_CREDENTIALS
  GOOGLE_GHA_CREDS_PATH AZURE_CLIENT_SECRET IDENTITY_HEADER MSI_SECRET
  AZURE_CLIENT_CERTIFICATE_PATH AZURE_CLIENT_CERTIFICATE_PASSWORD AZURE_PASSWORD
  AZURE_FEDERATED_TOKEN_FILE AWS_WEB_IDENTITY_TOKEN_FILE AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE CLOUDSDK_AUTH_ACCESS_TOKEN GOOGLE_OAUTH_ACCESS_TOKEN
  NODE_AUTH_TOKEN NUGET_AUTH_TOKEN CARGO_REGISTRY_TOKEN TWINE_PASSWORD TWINE_USERNAME PYPI_TOKEN
  PYPI_API_TOKEN UV_PUBLISH_TOKEN UV_PUBLISH_PASSWORD UV_PUBLISH_USERNAME FLIT_PASSWORD
  FLIT_USERNAME HATCH_INDEX_AUTH HATCH_INDEX_USER GEM_HOST_API_KEY MATURIN_PYPI_TOKEN
  MATURIN_PASSWORD MATURIN_USERNAME CONAN_LOGIN_USERNAME CONAN_PASSWORD ANACONDA_API_TOKEN
  BINSTAR_API_TOKEN VAULT_TOKEN VAULT_AUTH_TOKEN VAULT_ROLE_ID VAULT_SECRET_ID CONSUL_HTTP_TOKEN
  CONSUL_HTTP_AUTH NOMAD_TOKEN NOMAD_HTTP_AUTH CI_REGISTRY_USER CI_DEPLOY_USER JF_USER
  FASTLANE_SESSION MATCH_GIT_BASIC_AUTHORIZATION SONAR_TOKEN SONARQUBE_SCANNER_PARAMS
  SONAR_SCANNER_JSON_PARAMS SLACK_WEBHOOK_URL SLACK_WEBHOOK DISCORD_WEBHOOK DISCORD_WEBHOOK_URL
  TEAMS_WEBHOOK_URL MS_TEAMS_WEBHOOK_URI CLOUDSDK_AUTH_ACCESS_TOKEN_FILE
  CLOUDSDK_AUTH_AUTHORIZATION_TOKEN_FILE AZURE_AUTH_LOCATION ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ALL_INPUTS
  VSS_NUGET_EXTERNAL_FEED_ENDPOINTS ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS
  VSS_NUGET_ACCESSTOKEN ARTIFACTS_CREDENTIALPROVIDER_ACCESSTOKEN COMPOSER_AUTH
  OVERRIDE_GITHUB_TOKEN DEFAULT_WORKFLOW_TOKEN SSH_SIGNING_KEY HTTPS_PROXY HTTP_PROXY ALL_PROXY
  NPM_TOKEN CODEARTIFACT_AUTH_TOKEN PIP_INDEX_URL PIP_EXTRA_INDEX_URL UV_INDEX_URL
  UV_EXTRA_INDEX_URL UV_DEFAULT_INDEX UV_INDEX GOPROXY GOAUTH
`)

// A name that reads as a secret: a word such as TOKEN, KEY or PASSWORD at
// its end or between underscores (or digits), or a connection string. The
// CLI checks it only on the names of the package tools' prefixes below.
const SECRET_WORD = new RegExp(
  '((^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|AUTH|COOKIE|PAT|DSN|WEBHOOK|CREDENTIAL|' +
    'CREDENTIALS|CREDS|APIKEY|ACCESSKEY|SECRETKEY|ACCOUNTKEY|PRIVATEKEY|AUTHKEY|SSHKEY|SIGNINGKEY|' +
    'MASTERKEY|DEPLOYKEY|ENCRYPTIONKEY|PGPASSWORD|SSHPASS|(KEY|SECRET|PASSWORD|CREDENTIAL)S)|' +
    '_(PWD|PASS|JWT)|(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE))(?=$|[_0-9])',
  'i',
)
const CONNECTION_STRING = /CONN(ECT(ION)?)?_?STR(ING)?S?(?=$|[_0-9])/i
// Bundler's per-host credentials, BUNDLE_<HOST>__ with the dots as __.
const BUNDLER_CREDENTIAL = new RegExp(
  '^(?:INPUT_)?BUNDLE_(?!(?:BUILD|LOCAL|MIRROR|PATH|WITH|WITHOUT|CACHE|DISABLE|IGNORE|ONLY)__' +
    '(?!(?:[A-Za-z0-9]+(?:___[A-Za-z0-9]+)*__)+[A-Za-z]{2,}$))\\w*__',
  'i',
)

function secretName(name: string): boolean {
  const bare = name.replace(/^AUTH0_/i, '')
  // A digit runs into the next word in an upper-case name: S3TOKEN.
  const split = bare.replace(/([0-9])([A-Z])/g, '$1_$2')
  return (
    [bare, split].some((text) => SECRET_WORD.test(text) || CONNECTION_STRING.test(text)) ||
    BUNDLER_CREDENTIAL.test(bare)
  )
}

const PACKAGE_PREFIX = new RegExp(
  `^(?:${[
    'INPUT_',
    'ORG_GRADLE_PROJECT_',
    'POETRY_PYPI_TOKEN_',
    'POETRY_HTTP_BASIC_',
    'CARGO_REGISTRIES_',
    'CONAN_LOGIN_USERNAME_',
    'CONAN_PASSWORD_',
  ].join('|')})`,
)

// The credentials package tools take under a prefix of their own: all of
// them for two of the prefixes, a user name, or a name that reads as a secret.
function packageCredential(name: string): boolean {
  if (!PACKAGE_PREFIX.test(name)) return false
  return (
    /^(?:INPUT_)?(?:POETRY_HTTP_BASIC_|CONAN_LOGIN_USERNAME_)/.test(name) ||
    /USER(?:_?NAME)?_?[0-9]*$/.test(name) ||
    secretName(name)
  )
}

const bareName = (name: string) => name.toUpperCase().replace(/^INPUT_/, '')

// Whether the CLI keeps a variable that is set out of any server's config.
export function ownVariable(name: string): boolean {
  const bare = bareName(name)
  return /^_?(?:ANTHROPIC_|CLAUDE_CODE_)|^OTEL_/.test(bare) || OWN.has(bare)
}

// Whether the CLI keeps a variable out of a remote server's url and headers,
// set or not. Claude's own base URLs it keeps out when they carry a user or
// password; this keeps them out always, as it keeps its other variables.
export function remoteCredential(name: string): boolean {
  const bare = bareName(name)
  return (
    ownVariable(name) ||
    REMOTE.has(bare) ||
    /^GIT_CONFIG_(?:PARAMETERS|(?:KEY|VALUE)_[0-9]+)$/.test(bare) ||
    /^CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN$/.test(bare) ||
    packageCredential(bare) ||
    BUNDLER_CREDENTIAL.test(bare)
  )
}
