import React from "react";

type Props = { className?: string };

function Svg({ className, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.6" />
    <rect x="14" y="3" width="7" height="5" rx="1.6" />
    <rect x="14" y="12" width="7" height="9" rx="1.6" />
    <rect x="3" y="16" width="7" height="5" rx="1.6" />
  </Svg>
);

export const IconBroadcast = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6" />
    <path d="M5.4 5.4a9.4 9.4 0 0 0 0 13.2M18.6 18.6a9.4 9.4 0 0 0 0-13.2" />
  </Svg>
);

export const IconBot = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
    <path d="M12 3.2v4.3" />
    <circle cx="12" cy="2.8" r="1" />
    <circle cx="9" cy="12.7" r="1" />
    <circle cx="15" cy="12.7" r="1" />
    <path d="M9.6 16.4h4.8" />
  </Svg>
);

export const IconTag = (p: Props) => (
  <Svg {...p}>
    <path d="M20.6 13.4 12.9 21a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4V4.6A1.6 1.6 0 0 1 4.1 3h8a2 2 0 0 1 1.4.6l7.1 7a2 2 0 0 1 0 2.8Z" />
    <circle cx="7.5" cy="7.5" r="1.4" />
  </Svg>
);

export const IconDownload = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3v11" />
    <path d="m7.5 10 4.5 4.5L16.5 10" />
    <path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
  </Svg>
);

export const IconSettings = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
);

export const IconSearch = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);

export const IconPlus = (p: Props) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconRefresh = (p: Props) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-2.4 6.3" />
    <path d="M20 4.5V11h-6.4" />
  </Svg>
);

export const IconTrash = (p: Props) => (
  <Svg {...p}>
    <path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </Svg>
);

export const IconPlay = (p: Props) => (
  <Svg {...p}>
    <path d="M7 4.8v14.4L19.5 12 7 4.8Z" />
  </Svg>
);

export const IconPause = (p: Props) => (
  <Svg {...p}>
    <path d="M9.2 4.8v14.4M14.8 4.8v14.4" />
  </Svg>
);

export const IconStop = (p: Props) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);

/** 插队：双箭头指向上 */
export const IconPriority = (p: Props) => (
  <Svg {...p}>
    <path d="m12 4 5.5 5.5M12 4 6.5 9.5M12 11.5 17.5 17M12 11.5 6.5 17" />
  </Svg>
);

export const IconCheck = (p: Props) => (
  <Svg {...p}>
    <path d="m4.5 12.5 5 5L20 6.5" />
  </Svg>
);

export const IconAlert = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5 2.8 20h18.4L12 3.5Z" />
    <path d="M12 9.5v4.5M12 17.2v.1" />
  </Svg>
);

export const IconFile = (p: Props) => (
  <Svg {...p}>
    <path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V8l-4-5Z" />
    <path d="M14 3v5h4" />
  </Svg>
);

export const IconKey = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8-8M16.5 6.5l2 2M14.5 8.5l2 2" />
  </Svg>
);

export const IconLogout = (p: Props) => (
  <Svg {...p}>
    <path d="M9 21H5.8A1.8 1.8 0 0 1 4 19.2V4.8A1.8 1.8 0 0 1 5.8 3H9" />
    <path d="M16 16.5 20.5 12 16 7.5M20 12H9" />
  </Svg>
);

export const IconClock = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconX = (p: Props) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconChevronLeft = (p: Props) => (
  <Svg {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
);

export const IconChevronRight = (p: Props) => (
  <Svg {...p}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Svg>
);

export const IconChevronsLeft = (p: Props) => (
  <Svg {...p}>
    <path d="M13 5.5 6.5 12 13 18.5M19 5.5 12.5 12 19 18.5" />
  </Svg>
);

export const IconChevronsRight = (p: Props) => (
  <Svg {...p}>
    <path d="M11 5.5 17.5 12 11 18.5M5 5.5 11.5 12 5 18.5" />
  </Svg>
);

export const IconMenu = (p: Props) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconInbox = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 13.5h4l1.5 2.8h6l1.5-2.8h4" />
    <path d="M5.6 5.2 3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5l-2.1-8.3A2 2 0 0 0 16.5 3.7h-9a2 2 0 0 0-1.9 1.5Z" />
  </Svg>
);

export const IconVideo = (p: Props) => (
  <Svg {...p}>
    <rect x="2.8" y="6" width="12.6" height="12" rx="2.4" />
    <path d="m15.4 13 5.8 3.4V7.6L15.4 11" />
  </Svg>
);

export const IconPhoto = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.6" cy="10" r="1.6" />
    <path d="m4.5 17.5 5-5 4 4 2.2-2.2 3.8 3.7" />
  </Svg>
);

export const IconMusic = (p: Props) => (
  <Svg {...p}>
    <circle cx="7" cy="17.5" r="2.6" />
    <circle cx="18" cy="15.5" r="2.6" />
    <path d="M9.6 17.5V7.2L20.6 5v10.5" />
  </Svg>
);

export const IconShield = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3 5 5.8v5.6c0 4.4 2.9 8.2 7 9.6 4.1-1.4 7-5.2 7-9.6V5.8L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const IconEdit = (p: Props) => (
  <Svg {...p}>
    <path d="M4 20h4.2L20 8.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z" />
    <path d="m14.5 5.5 4 4" />
  </Svg>
);

export const IconQr = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20.5 14v3M14 20.5h3M20.5 20.5h.5" />
  </Svg>
);

export const IconSpark = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M4.8 7.2l2.8 2.8M16.4 14l2.8 2.8M3 12h4M17 12h4M4.8 16.8l2.8-2.8M16.4 10l2.8-2.8" />
  </Svg>
);

export const IconLink = (p: Props) => (
  <Svg {...p}>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);

export const IconSend = (p: Props) => (
  <Svg {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3l-6.5 18-3.5-7.5L3.5 10 21 3z" />
  </Svg>
);

export const IconCamera = (p: Props) => (
  <Svg {...p}>
    <path d="M4 8.5h2.6L8 6h8l1.4 2.5H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z" />
    <circle cx="12" cy="13.5" r="3.2" />
  </Svg>
);

export const IconUpload = (p: Props) => (
  <Svg {...p}>
    <path d="M12 15.5V4.2m0 0L7.8 8.4M12 4.2l4.2 4.2" />
    <path d="M4.5 15.5v2.8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.8" />
  </Svg>
);

export const IconCode = (p: Props) => (
  <Svg {...p}>
    <path d="m9 8-4.5 4L9 16M15 8l4.5 4L15 16" />
  </Svg>
);

export const IconImage = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m4 16 4.6-4.6 3.4 3.4 2.6-2.6L20 17" />
    <circle cx="8.4" cy="9.4" r="1.4" />
  </Svg>
);

export const IconCrop = (p: Props) => (
  <Svg {...p}>
    <path d="M6.5 2.5v15h15" />
    <path d="M2.5 6.5h15v15" />
  </Svg>
);
