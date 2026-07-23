import { getPrisma } from "@/lib/prisma";

export async function GET() {
  const checkedAt = new Date().toISOString();

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return Response.json({
      status: "ok",
      checkedAt,
      services: { application: "ok", database: "ok" },
    });
  } catch (error) {
    console.error("Health check failed", error);
    return Response.json(
      {
        status: "degraded",
        checkedAt,
        services: { application: "ok", database: "unavailable" },
      },
      { status: 503 },
    );
  }
}
