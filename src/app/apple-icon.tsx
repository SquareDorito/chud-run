import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#FC4C02",
          borderRadius: "40px",
        }}
      >
        <svg width="130" height="130" viewBox="0 0 64 64">
          <path
            d="M14 46 C18 30, 26 20, 34 25 C41 29, 36 42, 45 39 C50 37, 52 27, 50 18"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            cx="14"
            cy="46"
            r="5"
            fill="#10B981"
            stroke="#FFFFFF"
            strokeWidth="2.5"
          />
          <circle cx="50" cy="18" r="5" fill="#FFFFFF" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
