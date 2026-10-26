import type { FileKind } from "../../components/Icons";

// Fixed illustrative data only. This is not an alternate classifier or filesystem adapter.
export const sampleFiles: {
  name: string;
  kind: FileKind;
  extension: string;
  size: string;
  destination: string;
  personalDestination?: string;
}[] = [
  {
    name: "물리_실험보고서.pdf",
    kind: "pdf",
    extension: ".pdf",
    size: "2.4 MB",
    destination: "문서",
    personalDestination: "학교/물리",
  },
  {
    name: "제주도_여행.jpg",
    kind: "image",
    extension: ".jpg",
    size: "4.8 MB",
    destination: "이미지",
  },
  {
    name: "발표_최종.pptx",
    kind: "slides",
    extension: ".pptx",
    size: "8.2 MB",
    destination: "문서",
    personalDestination: "학교/발표",
  },
  {
    name: "여행_기록.mp4",
    kind: "video",
    extension: ".mp4",
    size: "24.6 MB",
    destination: "영상",
  },
  {
    name: "수업_필기.txt",
    kind: "text",
    extension: ".txt",
    size: "12 KB",
    destination: "문서",
    personalDestination: "학교/수업",
  },
  {
    name: "자료_모음.zip",
    kind: "archive",
    extension: ".zip",
    size: "6.1 MB",
    destination: "압축",
  },
];
