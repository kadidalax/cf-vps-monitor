/**
 * NodeDisplay - public monitor list controls.
 * Keeps search, group filtering, status filtering, and grid/table switching.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Flex,
  IconButton,
  SegmentedControl,
  Select,
  Text,
  TextField,
} from '@radix-ui/themes';
import { Grid3X3, Search, Table2, X } from 'lucide-react';
import NodeTable from './NodeTable';
import { ClientInfo, LiveDataMap } from '../types';
import { getLocalStorageItem, setLocalStorageItem } from '../utils/browserStorage';
import { filterMonitorNodes, getNodeGroups, NodeStatusFilter } from '../utils/monitorView';

interface NodeDisplayProps {
  nodes: ClientInfo[];
  liveData: LiveDataMap;
  gridRenderer: (nodes: ClientInfo[], liveData: LiveDataMap) => React.ReactNode;
  offlinePosition?: 'first' | 'keep' | 'last';
  includeHidden?: boolean;
}

export default function NodeDisplay({
  nodes,
  liveData,
  gridRenderer,
  offlinePosition = 'keep',
  includeHidden = false,
}: NodeDisplayProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() => {
    return getLocalStorageItem('nodeViewMode') === 'table' ? 'table' : 'grid';
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [statusFilter, setStatusFilter] = useState<NodeStatusFilter>('all');
  const searchRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => getNodeGroups(nodes), [nodes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

        event.preventDefault();
        searchRef.current?.querySelector('input')?.focus();
      }

      if (event.key === 'Escape' && searchTerm) {
        setSearchTerm('');
        searchRef.current?.querySelector('input')?.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [searchTerm]);

  const toggleView = (mode: 'grid' | 'table') => {
    setViewMode(mode);
    setLocalStorageItem('nodeViewMode', mode);
  };

  const filteredNodes = useMemo(() => {
    return filterMonitorNodes(nodes, liveData, {
      searchTerm,
      selectedGroup,
      statusFilter,
      offlinePosition,
    });
  }, [nodes, liveData, searchTerm, selectedGroup, statusFilter, offlinePosition]);

  const onlineVisibleCount = filteredNodes.filter((node) =>
    liveData.online.includes(node.uuid),
  ).length;
  return (
    <Box className="node-display-shell" style={{ width: '100%' }}>
      <Box className="node-filter-panel">
        <Flex className="node-filter-toolbar" direction="column" gap="2">
          <Flex className="node-filter-top-row" align="center" gap="2">
            <Box ref={searchRef} className="node-control-search">
              <TextField.Root
                placeholder="搜索服务器"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              >
                <TextField.Slot>
                  <Search size={16} />
                </TextField.Slot>
                {searchTerm && (
                  <TextField.Slot>
                    <IconButton
                      aria-label="清空搜索"
                      variant="ghost"
                      size="1"
                      onClick={() => {
                        setSearchTerm('');
                        searchRef.current?.querySelector('input')?.focus();
                      }}
                    >
                      <X size={12} />
                    </IconButton>
                  </TextField.Slot>
                )}
              </TextField.Root>
            </Box>

            <Box className="node-filter-spacer" aria-hidden="true" />

            <Flex className="node-filter-stats" align="center" gap="2">
              <Badge size="1" variant="soft" color="blue">
                当前结果 {filteredNodes.length}
              </Badge>
              <Badge size="1" variant="soft" color="green">
                在线 {onlineVisibleCount}
              </Badge>
              <Badge size="1" variant="soft" color="gray">
                总节点 {nodes.length}
              </Badge>
            </Flex>
          </Flex>

          <Flex className="node-filter-bottom-row" align="center" gap="2">
            <Box className="node-status-filter">
              <SegmentedControl.Root
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as NodeStatusFilter)}
                size="1"
              >
                <SegmentedControl.Item value="all">全部</SegmentedControl.Item>
                <SegmentedControl.Item value="online">在线</SegmentedControl.Item>
                <SegmentedControl.Item value="offline">离线</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Box>

            {groups.length > 0 && (
              <Box className="node-group-filter">
                <Select.Root value={selectedGroup} onValueChange={setSelectedGroup}>
                  <Select.Trigger aria-label="分组筛选" />
                  <Select.Content>
                    <Select.Item value="all">全部分组</Select.Item>
                    {groups.map((group) => (
                      <Select.Item key={group} value={group}>
                        {group}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Box>
            )}

            <Box className="node-filter-spacer" aria-hidden="true" />

            <Flex className="node-view-toggle" align="center" gap="1">
              <IconButton
                aria-label="网格视图"
                variant={viewMode === 'grid' ? 'solid' : 'soft'}
                size="2"
                onClick={() => toggleView('grid')}
              >
                <Grid3X3 size={16} />
              </IconButton>
              <IconButton
                aria-label="表格视图"
                variant={viewMode === 'table' ? 'solid' : 'soft'}
                size="2"
                onClick={() => toggleView('table')}
              >
                <Table2 size={16} />
              </IconButton>
            </Flex>
          </Flex>
        </Flex>
      </Box>

      {filteredNodes.length === 0 ? (
        <Flex direction="column" align="center" justify="center" style={{ padding: '64px 16px' }}>
          <Text size="4" color="gray">
            {searchTerm.trim() ? '未找到匹配的节点' : '暂无节点数据'}
          </Text>
        </Flex>
      ) : (
        <>
          {viewMode === 'grid'
            ? gridRenderer(filteredNodes, liveData)
            : <NodeTable nodes={filteredNodes} liveData={liveData} includeHidden={includeHidden} />}
        </>
      )}
    </Box>
  );
}
