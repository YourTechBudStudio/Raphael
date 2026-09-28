import { X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';

import type { ContainerRef, ContainerType } from '../../../infrastructure/api/contracts';
import {
  Chip,
  colors,
  IconButton,
  SavePill,
  SearchField,
  Sheet,
  SheetBody,
  SheetHeader,
} from '../../../ui';
import { filterTree, SelectableTree } from '../../browse';
import {
  ancestorsOf,
  useContainerDraft,
  useHierarchy,
  type HierarchyNode,
} from '../../collections';

export interface DestinationSheetProps {
  visible: boolean;
  /** Changes per opening, so each opening gets a fresh form. */
  sessionId: number;
  selected: ContainerRef | null;
  /** The chosen place. Persisting it is the caller's, and it may refuse. */
  onSelect: (destination: ContainerRef) => void;
  onClose: () => void;
}

const SUBTITLE_UNCHOSEN = 'Pick an area or a project. Raphael will not choose one for you.';

const CREATED_NOTE = 'Created on your server, whether or not this note is saved.';

/** Said when a new container did not reach the server: it is kept, and Unfinished has it. */
const KEPT_NOTE = 'Couldn’t save it yet. It’s kept in Unfinished and will keep trying.';

/**
 * Where does this go?
 *
 * The same tree Browse draws, as radios. Nothing is chosen for anybody: there is no default area, no
 * inbox and no inference from whatever screen this was opened over, which is the rule the whole
 * capture flow turns on.
 *
 * Because the draft is durable, this sheet can no longer lose writing. Cancelling, a failed create
 * and a refused create all leave the earlier selection and everything written exactly where they
 * were - a hierarchy that will not load is a hierarchy that will not load, not a reason to forget
 * where a note was going.
 *
 * Creating here goes through `collections`' container draft, and the copy says so: the container is
 * made whether or not the note is ever saved.
 */
export function DestinationSheet({
  visible,
  sessionId,
  selected,
  onSelect,
  onClose,
}: DestinationSheetProps) {
  const tree = useHierarchy();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [creating, setCreating] = useState<ContainerType | null>(null);
  /** Counts forms, so each New area or New project press is its own draft. */
  const [form, setForm] = useState(0);
  const hierarchy = tree.hierarchy;
  const roots = hierarchy?.roots ?? [];
  const filtering = query.trim() !== '';
  const nodes = useMemo(() => filterTree(roots, query), [roots, query]);

  // The chosen place and everything above it opens, so the check is on screen when the sheet does.
  const ancestorIds = useMemo(
    () => ancestorsOf(hierarchy, selected?.id ?? null).map((step) => step.id),
    [hierarchy, selected],
  );

  useEffect(() => {
    if (!visible || ancestorIds.length === 0) return;

    setExpanded((current) => new Set([...current, ...ancestorIds]));
  }, [visible, ancestorIds]);

  useEffect(() => {
    setCreating(null);
    setQuery('');
  }, [sessionId]);

  const selectedNode = selected === null ? null : (hierarchy?.byId.get(selected.id) ?? null);
  const subtitle =
    selectedNode === null
      ? SUBTITLE_UNCHOSEN
      : `Going in ${selectedNode.title}. Choose somewhere else, or close.`;

  /**
   * Where a new container goes, from what is selected and nothing else.
   *
   * Only a **selected area** is a place to create inside. A selected project is not: reaching for
   * its parent would file the new area beside the project, in an area nobody picked, and the
   * control would be describing somewhere other than where it was putting things. The rule is
   * "inside a selected area, otherwise at root", and "otherwise" includes a chosen project.
   *
   * New project needs an area to sit in either way, because the root holds only areas.
   */
  const insideArea = selected?.type === 'area' ? selected.id : null;
  const canCreateProject = insideArea !== null;

  const startCreating = (type: ContainerType) => {
    setForm((value) => value + 1);
    setCreating(type);
  };

  return (
    <Sheet
      className="gap-4 px-5 pb-4 pt-3"
      keyboardAvoiding
      label="the destination sheet"
      onClose={onClose}
      snapHeight={560}
      testID="destination-sheet"
      visible={visible}
    >
      <SheetHeader
        leading={<IconButton icon={X} label="Close" onPress={onClose} />}
        subtitle={subtitle}
        title="Where does this go?"
        trailing={<View className="w-11" />}
      />

      <SearchField
        accessibilityLabel="Filter areas and projects"
        onChangeText={setQuery}
        onClear={() => {
          setQuery('');
        }}
        placeholder="Find an area or project"
        value={query}
      />

      <SheetBody className="flex-1">
        {tree.isError && hierarchy === undefined ? (
          <Text
            accessibilityLiveRegion="polite"
            className="font-body text-[15px] leading-[22px] text-ink-soft"
          >
            Unable to load areas and projects. Where this note is going has not changed.
          </Text>
        ) : hierarchy === undefined ? (
          <View className="items-center py-8">
            <ActivityIndicator
              accessibilityLabel="Loading areas and projects"
              color={colors.primary}
            />
          </View>
        ) : nodes.length === 0 ? (
          <Text className="font-body text-[15px] leading-[22px] text-ink-soft">
            {filtering
              ? 'Nothing here matches that. Try a shorter word.'
              : 'No areas or projects yet. Make one below.'}
          </Text>
        ) : (
          <SelectableTree
            expandedIds={expanded}
            forceExpanded={filtering}
            nodes={nodes}
            onSelect={(node: HierarchyNode) => {
              onSelect({ type: node.type, id: node.id });
            }}
            onToggle={(id) => {
              setExpanded((current) => {
                const next = new Set(current);
                if (!next.delete(id)) next.add(id);

                return next;
              });
            }}
            selected={selected}
          />
        )}
      </SheetBody>

      {creating === null ? (
        <View className="flex-row gap-2">
          <Chip
            // The hint names where it will actually go. Saying "inside the chosen one" while a
            // project is selected would describe a placement this sheet does not make.
            accessibilityHint={
              insideArea === null
                ? 'Creates an area at the top level'
                : `Creates an area inside ${selectedNode?.title ?? 'the chosen area'}`
            }
            label="New area"
            onPress={() => {
              startCreating('area');
            }}
          />
          <Chip
            accessibilityHint={
              canCreateProject ? 'Creates a project inside the chosen area' : 'Choose an area first'
            }
            disabled={!canCreateProject}
            label="New project"
            onPress={() => {
              startCreating('project');
            }}
          />
        </View>
      ) : (
        <InlineCreate
          containerType={creating}
          key={form}
          onCancel={() => {
            setCreating(null);
          }}
          onCreated={onSelect}
          parentAreaId={insideArea}
        />
      )}
    </Sheet>
  );
}

interface InlineCreateProps {
  containerType: ContainerType;
  parentAreaId: number | null;
  onCreated: (container: ContainerRef) => void;
  onCancel: () => void;
}

/** A title and Create, inside the sheet. Nothing is navigated to: the new place is selected. */
function InlineCreate({ containerType, parentAreaId, onCreated, onCancel }: InlineCreateProps) {
  const draft = useContainerDraft({ draftId: null, containerType, parentAreaId });
  const [title, setTitle] = useState('');
  const [kept, setKept] = useState(false);
  const [unwritable, setUnwritable] = useState(false);
  const titleInput = useRef<TextInput>(null);

  useEffect(() => {
    const timer = setTimeout(() => titleInput.current?.focus(), 0);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  const create = () => {
    if (draft.saving || title.trim() === '') return;

    void draft.save({ title }).then((outcome) => {
      if (outcome.kind === 'created') onCreated(outcome.container);
      setKept(outcome.kind === 'kept');
      setUnwritable(outcome.kind === 'unwritable');
    });
  };

  const refusal = draft.row?.status === 'refused' ? `Not saved: ${draft.row.error ?? ''}` : null;

  return (
    <View className="gap-2">
      <Text className="font-body text-[13px] leading-[18px] text-ink-soft">{CREATED_NOTE}</Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel={containerType === 'area' ? 'Area title' : 'Project title'}
          className="h-11 flex-1 rounded-full bg-card px-4 font-body text-[16px] text-ink"
          editable={!draft.saving}
          onChangeText={(value) => {
            setTitle(value);
            draft.write({ title: value });
          }}
          onSubmitEditing={create}
          placeholder={containerType === 'area' ? 'New area' : 'New project'}
          ref={titleInput}
          returnKeyType="done"
          value={title}
        />
        <SavePill
          accessibilityHint={`Creates this ${containerType} on your server`}
          disabled={draft.saving || title.trim() === ''}
          label={draft.saving ? 'Saving…' : 'Create'}
          onPress={create}
        />
        <IconButton
          icon={X}
          label="Cancel"
          onPress={() => {
            void draft.leave({ title }).then((left) => {
              if (left === 'unwritable') setUnwritable(true);
              else onCancel();
            });
          }}
        />
      </View>
      {refusal === null ? null : (
        <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
          {refusal}
        </Text>
      )}
      {unwritable ? (
        <Text accessibilityLiveRegion="assertive" className="font-body text-[15px] text-danger">
          Couldn’t save on this phone.
        </Text>
      ) : null}
      {kept && refusal === null ? (
        <Text
          accessibilityLiveRegion="assertive"
          className="font-body text-[15px] leading-[22px] text-ink"
        >
          {KEPT_NOTE}
        </Text>
      ) : null}
    </View>
  );
}
