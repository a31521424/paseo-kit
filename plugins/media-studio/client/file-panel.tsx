import { useWorkspace, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { MediaViewer } from "./player";

/** Video, audio and the image formats Paseo cannot show, opened from the Explorer or a file link. */
export function MediaFilePanel({ theme, layout, workspaceId, file }: PluginFilePanelProps) {
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [version, setVersion] = useState(0);
  useEffect(() => file.watch((event) => event.type === "changed" && setVersion((value) => value + 1)), [file]);
  const [height, setHeight] = useState(0);
  // Tall enough panels fill their height; short or phone-sized ones scroll instead.
  const fill = !layout.compact && height >= 520;
  const viewer = (
    <MediaViewer
      theme={theme}
      compact={layout.compact}
      path={file.path}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      agentId={null}
      variant="panel"
      version={version}
      fill={fill}
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      {fill ? (
        <View style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 16 }}>{viewer}</View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 10 : 16 }}>
          {viewer}
        </ScrollView>
      )}
    </View>
  );
}
