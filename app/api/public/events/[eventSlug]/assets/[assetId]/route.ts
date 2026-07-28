import { findPublishedEventAsset } from "@/modules/events/asset-repository";
import { eventAssetResponse } from "@/modules/events/asset-response";
import { logError } from "@/lib/logger";
import { withRequestContext } from "@/lib/request-context";

type RouteContext = { params: Promise<{ eventSlug: string; assetId: string }> };

/**
 * Public download for a file a published event page links to.
 *
 * No session, because the page it appears on has no session either. The
 * protection is the lookup: an asset is reachable only while a published
 * section of a published event links to it, so unpublishing a section takes its
 * files down with it and an unreferenced upload is not one guessed identifier
 * from being public.
 */
async function getHandler(_request: Request, context: RouteContext) {
  try {
    const { assetId } = await context.params;
    const asset = await findPublishedEventAsset(assetId);
    if (!asset) {
      // The same answer whether the id is wrong, the section is a draft, or the
      // event is unpublished. Distinguishing them would confirm what exists.
      return new Response("Not found", { status: 404 });
    }
    return eventAssetResponse(asset);
  } catch (error) {
    logError("Serving a public event file failed", error);
    return new Response("Unavailable", { status: 500 });
  }
}

export const GET = withRequestContext(getHandler);
