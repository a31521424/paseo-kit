import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { subscribeNotices } from "./downloads";

/**
 * Renders nothing. Plugin toasts need a mounted component, and the save shortcut runs outside any,
 * so this sidebar footer item stays mounted and shows the shortcut's notices.
 */
export function NoticeHost() {
  const toast = useToast();
  useEffect(
    () =>
      subscribeNotices(({ message, variant }) => {
        if (variant === "error") toast.error(message);
        else toast.show(message, { variant });
      }),
    [toast],
  );
  return null;
}
