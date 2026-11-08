import {
  anchorConfigSchema,
  moderatorConfigSchema,
  moleDiscoverySchema,
} from "../../../shared/mole";
import { errorSchema, metadataSchema, resourceSchema } from "../../../shared/schemas";
import { claims, fail, hash, permittedUrl, readText } from "../../../shared/protocol";

// Configured peer origins are an intentional network boundary in this fixed-site
// demo. New providers need explicit operator configuration, never challenge trust.
export class MoleTransport {
  private endpoints = new Set<string>();
  private grant = "";
  constructor(
    private storage: DurableObjectStorage,
    private env: CallerEnv,
  ) {}

  private url(raw: string, configuration = false) {
    const url = permittedUrl(raw, this.env.LOCAL_DEMO === "true");
    const provider = this.env.MOLE_PROVIDER_ORIGIN || this.env.RECEIVER_ORIGIN;

    const anchor = this.env.MOLE_ANCHOR_CONFIG_URI
      ? new URL(this.env.MOLE_ANCHOR_CONFIG_URI).origin
      : provider;

    if (
      ![this.env.RECEIVER_ORIGIN, provider, anchor].includes(url.origin) ||
      (configuration && url.search)
    )
      fail("untrusted_mole_endpoint");

    return url;
  }

  private async send(url: URL, init: RequestInit) {
    const response =
      url.origin === this.env.RECEIVER_ORIGIN
        ? await this.env.RECEIVER.fetch(url.href, init)
        : this.env.MOLE_PROVIDER
          ? await this.env.MOLE_PROVIDER.fetch(url.href, init)
          : await fetch(url.href, init);

    return response;
  }

  async request(raw: string, init: RequestInit = {}) {
    const url = this.url(raw);

    if (url.origin !== this.env.RECEIVER_ORIGIN && !this.endpoints.has(url.href))
      fail("untrusted_mole_endpoint");
    const headers = new Headers();

    for (const [name, value] of new Headers(init.headers)) {
      if (!["authorization", "content-type", "x-guac-grant"].includes(name.toLowerCase()))
        fail("invalid_private_header");
      headers.set(name, value);
    }

    if (url.href === this.grant) {
      const invite = this.storage.kv.get<string>("anchor-invite");

      if (!invite) fail("anchor_sign_in_required", 403);
      // Only the Anchor sees the provisioned account capability and assertion.
      // No Company query, challenge, or Poppy identity enters this request.
      headers.set("Northstar-Invite", invite);
      headers.set(
        "Northstar-Eligibility",
        await this.env.IDENTITY.getByName("signing-key").assertion(
          claims(this.env.CALLER_ORIGIN + "/agent.json", await hash(invite), this.grant),
        ),
      );
    }

    const response = await this.send(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });

    if (url.href === this.grant && !response.ok) {
      const error = errorSchema.safeParse(JSON.parse(await readText(response)));
      fail(error.success ? error.data.error : "anchor_access_denied", response.status);
    }

    return response;
  }

  private async company() {
    const discovery = await this.request(this.env.RECEIVER_ORIGIN + "/.well-known/poppy.json");
    let moderatorConfig = this.env.MOLE_MODERATOR_CONFIG_URI;

    if (discovery.ok) {
      const company = moleDiscoverySchema.parse(JSON.parse(await readText(discovery)));

      if (company.organization.domain !== new URL(this.env.RECEIVER_ORIGIN).hostname)
        fail("invalid_metadata");

      if (company.auth?.issuer) {
        if (company.auth.issuer !== this.env.RECEIVER_ORIGIN) fail("invalid_metadata");

        const resourceResponse = await this.request(
          this.env.RECEIVER_ORIGIN + "/.well-known/oauth-protected-resource",
        );

        const issuerResponse = await this.request(
          this.env.RECEIVER_ORIGIN + "/.well-known/oauth-authorization-server",
        );

        if (!resourceResponse.ok || !issuerResponse.ok) fail("invalid_metadata");
        const resource = resourceSchema.parse(JSON.parse(await readText(resourceResponse)));
        const issuer = metadataSchema.parse(JSON.parse(await readText(issuerResponse)));

        if (
          resource.resource !== this.env.RECEIVER_ORIGIN ||
          !resource.authorization_servers.includes(company.auth.issuer) ||
          issuer.issuer !== company.auth.issuer ||
          !issuer.protected_resources.includes(this.env.RECEIVER_ORIGIN)
        )
          fail("invalid_metadata");
      }

      if (company.web?.disabled) this.storage.kv.put("private-web-disabled", true);
      else this.storage.kv.delete("private-web-disabled");
      const advertised = company.extensions?.mole?.find((entry) => entry.version === "1");

      if (advertised) {
        if (!advertised.moderator_config_uri) fail("invalid_mole_configuration");
        moderatorConfig = advertised.moderator_config_uri;
      }
    } else if (discovery.status !== 404) fail("mole_discovery_failed", discovery.status);

    return moderatorConfig;
  }
  async checkBrowsing() {
    await this.company();

    if (this.storage.kv.get<boolean>("private-web-disabled"))
      fail("company_disables_browsing", 403);
  }
  async configuration() {
    const moderatorConfig = await this.company();

    if (!moderatorConfig) fail("mole_configuration_unavailable", 409);
    const moderatorUrl = this.url(moderatorConfig, true);

    const anchorConfig =
      this.env.MOLE_ANCHOR_CONFIG_URI ||
      (this.env.MOLE_PROVIDER_ORIGIN || this.env.RECEIVER_ORIGIN) + "/mole/anchor/config";

    const anchorUrl = this.url(anchorConfig, true);
    this.endpoints.add(moderatorUrl.href);
    this.endpoints.add(anchorUrl.href);
    const m = await this.request(moderatorUrl.href);
    const a = await this.request(anchorUrl.href);

    if (!m.ok || !a.ok) fail("mole_configuration_unavailable", 409);
    const moderator = moderatorConfigSchema.parse(JSON.parse(await readText(m)));
    const anchor = anchorConfigSchema.parse(JSON.parse(await readText(a)));

    const matches = moderator.endorsements.some(
      (entry) =>
        entry["endorsement-type"] === 2 &&
        entry.ciphersuite === anchor.ciphersuite &&
        entry["issuance-epoch"] === anchor["issuance-epoch"] &&
        entry["anchor-set"].includes(anchor["anchor-key"]),
    );

    if (!matches) fail("no_usable_anchor", 409);
    this.endpoints.add(this.url(moderator["issuance-uri"]).href);
    this.grant = this.url(anchor["grant-uri"]).href;
    this.endpoints.add(this.grant);

    return { moderatorConfig: moderatorUrl.href, anchorConfig: anchorUrl.href };
  }
}
