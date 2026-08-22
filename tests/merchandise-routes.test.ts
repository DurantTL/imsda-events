import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  findActiveMembership: vi.fn(),
  getCurrentSession: vi.fn(),
  getMerchandiseCatalog: vi.fn(),
  getMerchandiseCatalogForProjection: vi.fn(),
  saveCatalog: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  archiveVariant: vi.fn(),
}));

vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));

vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
}));

vi.mock("@/modules/merchandise/catalog-repository", () => ({
  getMerchandiseCatalog: dependencies.getMerchandiseCatalog,
  getMerchandiseCatalogForProjection: dependencies.getMerchandiseCatalogForProjection,
  saveCatalog: dependencies.saveCatalog,
  createProduct: dependencies.createProduct,
  updateProduct: dependencies.updateProduct,
  createVariant: dependencies.createVariant,
  updateVariant: dependencies.updateVariant,
  archiveVariant: dependencies.archiveVariant,
}));

import { GET as getCatalog, PATCH as patchCatalog } from "@/app/api/events/[eventId]/merchandise/route";
import { POST as postProduct } from "@/app/api/events/[eventId]/merchandise/products/route";
import { PATCH as patchProduct } from "@/app/api/events/[eventId]/merchandise/products/[productId]/route";
import { POST as postVariant } from "@/app/api/events/[eventId]/merchandise/products/[productId]/variants/route";
import { PATCH as patchVariant, DELETE as deleteVariant } from "@/app/api/events/[eventId]/merchandise/products/[productId]/variants/[variantId]/route";
import { GET as getPreview } from "@/app/api/events/[eventId]/merchandise/preview/route";

const eventId = "event_1";
const productId = "product_1";
const variantId = "variant_1";
const origin = "https://events.imsda.test";

function jsonRequest(path: string, method: string, body?: unknown) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const productParams = { params: Promise.resolve({ eventId }) };
const productIdParams = { params: Promise.resolve({ eventId, productId }) };
const variantParams = { params: Promise.resolve({ eventId, productId, variantId }) };

/** One route case per merchandise endpoint that can mutate or read staff-only
 * catalog data, so a single authorization defect can't slip past by only
 * being covered on one route. */
const routeCases: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: "GET catalog", call: () => getCatalog(jsonRequest(`/api/events/${eventId}/merchandise`, "GET"), productParams) },
  { name: "PATCH catalog", call: () => patchCatalog(jsonRequest(`/api/events/${eventId}/merchandise`, "PATCH", { isEnabled: true }), productParams) },
  { name: "POST product", call: () => postProduct(jsonRequest(`/api/events/${eventId}/merchandise/products`, "POST", { name: "Shirt" }), productParams) },
  { name: "PATCH product", call: () => patchProduct(jsonRequest(`/api/events/${eventId}/merchandise/products/${productId}`, "PATCH", { name: "Shirt" }), productIdParams) },
  { name: "POST variant", call: () => postVariant(jsonRequest(`/api/events/${eventId}/merchandise/products/${productId}/variants`, "POST", { label: "Medium", availability: { priceCents: 1000 } }), productIdParams) },
  { name: "PATCH variant", call: () => patchVariant(jsonRequest(`/api/events/${eventId}/merchandise/products/${productId}/variants/${variantId}`, "PATCH", { label: "Medium", availability: { priceCents: 1000 } }), variantParams) },
  { name: "DELETE (archive) variant", call: () => deleteVariant(jsonRequest(`/api/events/${eventId}/merchandise/products/${productId}/variants/${variantId}`, "DELETE"), variantParams) },
  { name: "GET preview", call: () => getPreview(jsonRequest(`/api/events/${eventId}/merchandise/preview`, "GET"), productParams) },
];

function expectNoRepositoryCalls() {
  expect(dependencies.getMerchandiseCatalog).not.toHaveBeenCalled();
  expect(dependencies.getMerchandiseCatalogForProjection).not.toHaveBeenCalled();
  expect(dependencies.saveCatalog).not.toHaveBeenCalled();
  expect(dependencies.createProduct).not.toHaveBeenCalled();
  expect(dependencies.updateProduct).not.toHaveBeenCalled();
  expect(dependencies.createVariant).not.toHaveBeenCalled();
  expect(dependencies.updateVariant).not.toHaveBeenCalled();
  expect(dependencies.archiveVariant).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("merchandise route authorization", () => {
  it.each(routeCases)("rejects an unauthenticated caller on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({ user: null });

    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "AUTHENTICATION_REQUIRED" });
    expect(dependencies.findActiveMembership).not.toHaveBeenCalled();
    expectNoRepositoryCalls();
  });

  it.each(routeCases)("rejects a staff member without the CONFIGURE_EVENT permission on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_readonly", email: "readonly@example.test", displayName: "Read Only Staff", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue({
      eventId, userId: "usr_readonly", role: "READ_ONLY_STAFF", status: "ACTIVE", permissions: [],
    });

    const response = await call();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "PERMISSION_DENIED" });
    expectNoRepositoryCalls();
  });

  it.each(routeCases)("rejects a caller with no membership for this event on $name", async ({ call }) => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_outsider", email: "outsider@example.test", displayName: "Outsider", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "EVENT_ACCESS_DENIED" });
    expectNoRepositoryCalls();
  });

  it("allows a CONFIGURE_EVENT member through to the underlying operation", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_admin", email: "admin@example.test", displayName: "Event Admin", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue({
      eventId, userId: "usr_admin", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [],
    });
    dependencies.createProduct.mockResolvedValue({ id: "product_new", name: "Shirt" });

    const response = await postProduct(jsonRequest(`/api/events/${eventId}/merchandise/products`, "POST", { name: "Shirt" }), productParams);

    expect(response.status).toBe(201);
    expect(dependencies.createProduct).toHaveBeenCalledWith(eventId, expect.objectContaining({ name: "Shirt" }), "usr_admin");
  });

  it("rejects a cross-origin mutation before it reaches authorization or the repository", async () => {
    dependencies.getCurrentSession.mockResolvedValue({
      user: { id: "usr_admin", email: "admin@example.test", displayName: "Event Admin", globalRole: null },
    });
    dependencies.findActiveMembership.mockResolvedValue({
      eventId, userId: "usr_admin", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [],
    });

    const response = await postProduct(
      new Request(`${origin}/api/events/${eventId}/merchandise/products`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://untrusted.example" },
        body: JSON.stringify({ name: "Shirt" }),
      }),
      productParams,
    );

    expect(response.status).toBe(403);
    expect(dependencies.findActiveMembership).not.toHaveBeenCalled();
    expectNoRepositoryCalls();
  });
});
