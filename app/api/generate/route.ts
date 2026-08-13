import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const apiUrl = process.env.LIGHTNING_API_URL;
    const apiKey = process.env.LIGHTNING_API_KEY;

    if (!apiUrl || !apiKey) {
      return NextResponse.json(
        { error: "Lightning API environment variables are not configured" },
        { status: 500 }
      );
    }

    const incoming = await request.formData();
    const image = incoming.get("image");
    const width = incoming.get("width") ?? "295";
    const height = incoming.get("height") ?? "413";

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "image is required" }, { status: 400 });
    }

    const formData = new FormData();
    formData.append("image", image);
    formData.append("width", String(width));
    formData.append("height", String(height));

    const response = await fetch(`${apiUrl}/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        { error: text || `Lightning API error: ${response.status}` },
        { status: response.status }
      );
    }

    return new NextResponse(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") || "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to call Lightning API" },
      { status: 500 }
    );
  }
}