"use client";

import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { MoreVertical } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface Props {
  readonly deviceToolbarVisible: boolean;
  readonly onToggleDeviceToolbar: () => void;
  readonly holdControl: boolean;
  readonly onHoldControlChange: (held: boolean) => void;
  readonly pictureInPicture: boolean;
  readonly onPictureInPicture: () => void;
  readonly onReload: () => void;
  readonly colorScheme: DesktopPreviewColorScheme;
  readonly onColorSchemeChange: (scheme: DesktopPreviewColorScheme) => void;
}

/** Browser controls shared with the native surface, scoped to the environment's streamed tab. */
export function ServerPreviewMoreMenu({
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  holdControl,
  onHoldControlChange,
  pictureInPicture,
  onPictureInPicture,
  onReload,
  colorScheme,
  onColorSchemeChange,
}: Props) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={onReload}>Reload</MenuItem>
        <MenuItem onClick={onPictureInPicture}>
          {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
        </MenuItem>
        <MenuItem onClick={onToggleDeviceToolbar}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>Appearance</MenuSubTrigger>
          <MenuSubPopup className="min-w-32">
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  onColorSchemeChange(value);
                }
              }}
            >
              <MenuRadioItem value="system">System</MenuRadioItem>
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuCheckboxItem checked={holdControl} onCheckedChange={onHoldControlChange}>
          Pause agent while I browse
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
