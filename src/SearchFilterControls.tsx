import { useEffect, useState } from "react";
import { listSearchDrives } from "./native";
import type { SearchFilters } from "./types";

const COMMON_EXTENSIONS = [
  "docx", "doc", "pdf", "txt", "md",
  "xlsx", "xls", "csv", "pptx", "ppt",
  "jpg", "jpeg", "png", "gif", "webp", "svg",
  "zip", "rar", "7z",
  "exe", "lnk",
  "py", "js", "ts", "tsx", "java", "c", "cpp", "rs",
];

export function SearchFilterControls({
  className,
  filters,
  onChange,
  showHint = false,
}: {
  className: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  showHint?: boolean;
}) {
  const [drives, setDrives] = useState<string[]>([]);
  const extensions = filters.extension && !COMMON_EXTENSIONS.includes(filters.extension)
    ? [filters.extension, ...COMMON_EXTENSIONS]
    : COMMON_EXTENSIONS;

  useEffect(() => {
    let active = true;
    void listSearchDrives().then((available) => {
      if (!active) return;
      setDrives(available);
      if (filters.drive && !available.includes(filters.drive)) {
        onChange({ ...filters, drive: "" });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className={className}>
      <select
        aria-label="搜索类型"
        value={filters.kind}
        onChange={(event) =>
          onChange({
            ...filters,
            kind: event.target.value as SearchFilters["kind"],
          })
        }
      >
        <option value="all">全部类型</option>
        <option value="link">快捷链接</option>
        <option value="app">应用</option>
        <option value="folder">文件夹</option>
        <option value="file">文件</option>
      </select>
      <select
        aria-label="文件扩展名"
        value={filters.extension}
        onChange={(event) =>
          onChange({ ...filters, extension: event.target.value })
        }
      >
        <option value="">全部扩展名</option>
        {extensions.map((extension) => (
          <option value={extension} key={extension}>.{extension}</option>
        ))}
      </select>
      <select
        aria-label="所在磁盘"
        value={filters.drive}
        onChange={(event) =>
          onChange({ ...filters, drive: event.target.value })
        }
      >
        <option value="">全部磁盘</option>
        {drives.map((drive) => (
          <option value={drive} key={drive}>{drive}</option>
        ))}
      </select>
      {showHint ? <span>筛选条件会同步到快捷搜索浮窗</span> : null}
    </div>
  );
}
